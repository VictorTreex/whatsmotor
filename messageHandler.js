const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

class MessageHandler {
  // ✅ PASSO 0 — Mapa para controle de concorrência
  static activeProcessing = new Map(); // userId:customerNumber -> timestamp

  // ✅ FUNÇÃO — Safe send com retry automático
  static async safeSend(sock, jid, text, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await sock.sendMessage(jid, { text });
      } catch (sendError) {
        logger.warn(`⚠️ Send attempt ${attempt} failed for ${jid}:`, sendError.message);
        
        if (attempt === maxRetries) {
          throw sendError; // Última tentativa falhou
        }
        
        // Esperar antes de tentar novamente
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  static async handleIncomingMessage(m, userId, sock, supabaseService) {
    try {
      logger.info(`📩 EVENT messages.upsert received`);
      const message = m.messages[0];
      
      // ✅ PASSO 1 — Proteção contra eventos duplicados
      if (!message.message) {
        logger.debug(`Empty message received for user ${userId}`);
        return;
      }

      // Ignorar mensagens de grupos
      if (message.key.remoteJid?.endsWith('@g.us')) {
        logger.debug(`Group message ignored for user ${userId}: ${message.key.remoteJid}`);
        return;
      }

      // Ignorar mensagens enviadas pelo próprio usuário
      if (message.key.fromMe) {
        logger.debug(`Own message ignored for user ${userId}`);
        return;
      }

      // Extrair conteúdo da mensagem
      const messageContent = message.message.conversation || 
                            message.message.extendedTextMessage?.text || 
                            '';

      if (!messageContent.trim()) {
        logger.debug(`Empty text message ignored for user ${userId}`);
        return;
      }

      // ✅ PASSO 2 — Validar mensagem (anti-spam, etc)
      const validation = this.validateMessage(messageContent);
      if (!validation.isValid) {
        logger.info(`🚫 Message validation failed for user ${userId}, reason: ${validation.reason}`);
        return;
      }

      const customerNumber = message.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown';
      const messageId = message.key.id || `unknown_${Date.now()}`;
      const processingKey = `${userId}:${messageId}`;
      
      // ✅ Verificar se já está processando esta mesma mensagem
      const now = Date.now();
      const lastProcessing = this.activeProcessing.get(processingKey);
      
      if (lastProcessing && (now - lastProcessing) < 5000) { // 5 segundos de proteção
        logger.info(`⚠️ Duplicate message processing prevented for user ${userId}, message ${messageId}`);
        return;
      }
      
      // Marcar como processando
      this.activeProcessing.set(processingKey, now);
      
      // Limpar entradas antigas (manter mapa limpo)
      for (const [key, timestamp] of this.activeProcessing.entries()) {
        if (now - timestamp > 30000) { // 30 segundos
          this.activeProcessing.delete(key);
        }
      }

      logger.info(`📨 Incoming valid customer message from ${customerNumber}: "${messageContent.substring(0, 50)}..."`);

      // 1. Obter configuração de auto resposta
      const autoResponderConfig = await supabaseService.getAutoResponderConfig(userId);
      
      if (!autoResponderConfig) {
        logger.info(`❌ No active auto responder config for user ${userId}`);
        return;
      }

      logger.info(`✅ Auto responder enabled, welcome message loaded for user ${userId}`);

      // 2. Usar welcome message e cooldown fixo
      const autoReplyText = autoResponderConfig.message_text;
      const cooldownHours = 24;

      // 3. Validar mensagem de boas-vindas
      if (!autoReplyText || !autoReplyText.trim()) {
        logger.info(`❌ Empty welcome message for user ${userId}`);
        return;
      }

      // 4. Verificar cooldown com proteção completa
      let isInCooldown = false;
      
      try {
        // ✅ PASSO 1 — Proteção contra falhas no Supabase
        let cooldownData = null;
        
        try {
          cooldownData = await supabaseService.checkCooldown(userId, customerNumber);
        } catch (cooldownError) {
          logger.error(`❌ Cooldown check failed for user ${userId}, customer ${customerNumber}:`, cooldownError);
          // Continuar sem cooldown em caso de erro
        }
        
        // ✅ PASSO 2 — Validar retorno do Supabase
        if (cooldownData && typeof cooldownData === 'object' && cooldownData.last_sent_at) {
          // ✅ PASSO 3 — Validar data e evitar Invalid Date
          const lastDate = new Date(cooldownData.last_sent_at);
          
          if (!isNaN(lastDate.getTime())) {
            const cooldownTime = new Date(lastDate);
            cooldownTime.setHours(cooldownTime.getHours() + cooldownHours);
            
            if (new Date() < cooldownTime) {
              logger.info(`⏰ Customer in cooldown for user ${userId}, customer ${customerNumber}. Next reply at: ${cooldownTime}`);
              isInCooldown = true;
            }
          } else {
            logger.warn(`⚠️ Invalid last_sent_at format for user ${userId}, customer ${customerNumber}: ${cooldownData.last_sent_at}`);
          }
        } else if (cooldownData) {
          logger.warn(`⚠️ Invalid cooldown data structure for user ${userId}, customer ${customerNumber}`);
        }
        
      } catch (error) {
        logger.error(`💥 Critical error in cooldown logic for user ${userId}, customer ${customerNumber}:`, error);
        // Continuar sem cooldown em caso de erro crítico
      }
      
      // ✅ PASSO 4 — Retornar se ainda em cooldown
      if (isInCooldown) {
        return;
      }

      // 5. Enviar resposta automática (LOG DEPOIS - NÃO BLOQUEIA)
      const fullJid = customerNumber + '@s.whatsapp.net';
      logger.info(`📤 Sending welcome auto reply to ${customerNumber} for user ${userId}`);
      logger.info(`📋 Send details: JID=${fullJid}, Attempt=1, MaxRetries=2, MessageLength=${autoReplyText.length}`);
      
      // ✅ PASSO 1 — Validar socket antes de enviar
      if (!sock?.user) {
        logger.warn(`⚠️ Socket not ready for user ${userId}, skipping message to ${customerNumber}`);
        return;
      }
      
      // ✅ PASSO 2 — Delay apenas para conexões recentes (evita erro 515 sem lentidão)
      if (sock.startTime && (Date.now() - sock.startTime < 5000)) {
        logger.info(`⏳ Recent connection detected, waiting 2s to stabilize...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      try {
        await this.safeSend(sock, customerNumber + '@s.whatsapp.net', autoReplyText);
        
        logger.info(`✅ Welcome auto reply sent successfully to ${customerNumber}`);
        
        // 6. Logar mensagem recebida (APÓS ENVIO - NÃO BLOQUEIA)
        try {
          await supabaseService.logIncomingMessage(userId, customerNumber, messageContent);
        } catch (logError) {
          logger.error(`❌ Failed to log incoming message for user ${userId}, customer ${customerNumber}:`, logError);
        }
        
        // 7. Logar mensagem enviada
        try {
          await supabaseService.logOutgoingMessage(userId, customerNumber, autoReplyText);
        } catch (logError) {
          logger.error(`❌ Failed to log outgoing message for user ${userId}, customer ${customerNumber}:`, logError.message);
        }
        
        // 8. Atualizar cooldown
        try {
          await supabaseService.updateCooldown(userId, customerNumber);
        } catch (cooldownError) {
          logger.error(`❌ Failed to update cooldown for user ${userId}, customer ${customerNumber}:`, cooldownError.message);
        }
        
        logger.info(`🎉 Auto reply process completed for user ${userId}, customer ${customerNumber}`);
        
      } catch (sendError) {
        logger.error(`❌ Auto reply send failed to ${customerNumber}:`, sendError.message);
        
        // ✅ CORREÇÃO — Log simples sem chamadas que podem falhar
        try {
          await supabaseService.logMessage(userId, {
            direction: 'out',
            from_number: 'bot',
            to_number: customerNumber,
            content: autoReplyText,
            message_type: 'text',
            status: 'failed',
            is_auto_reply: true,
            error_message: sendError.message
          });
        } catch (logError) {
          logger.error(`❌ Failed to log send error:`, logError.message);
        }
        
        // Não fazer throw para não quebrar o fluxo principal
      }

    } catch (error) {
      logger.error(`💥 Error handling message for user ${userId}:`, error);
      
      // ✅ CORREÇÃO — Log simples sem chamadas que podem falhar
      try {
        await supabaseService.logMessage(userId, {
          direction: 'system',
          from_number: 'system',
          to_number: 'system',
          content: `Error processing message: ${error.message}`,
          message_type: 'system',
          status: 'error',
          is_auto_reply: false
        });
      } catch (logError) {
        logger.error('Failed to log error message:', logError.message);
      }
    }
  }

  // Método para formatar mensagem de boas-vindas (opcional)
  static formatWelcomeMessage(template, customerInfo = {}) {
    let message = template;
    
    // Substituir placeholders básicos
    message = message.replace(/\{nome\}/g, customerInfo.name || 'cliente');
    message = message.replace(/\{telefone\}/g, customerInfo.phone || '');
    message = message.replace(/\{data\}/g, new Date().toLocaleDateString('pt-BR'));
    message = message.replace(/\{hora\}/g, new Date().toLocaleTimeString('pt-BR'));
    
    return message;
  }

  // Método para validar mensagem (anti-spam, etc)
  static validateMessage(messageContent) {
    const content = messageContent.toLowerCase().trim();
    
    // Lista de palavras que podem indicar spam
    const spamKeywords = ['promoção', 'oferta', 'desconto', 'grátis', 'ganhe', 'clique aqui'];
    
    // Verificar se contém muitas palavras de spam
    const spamCount = spamKeywords.filter(keyword => content.includes(keyword)).length;
    
    // Se tiver mais de 2 palavras de spam, pode ser spam
    if (spamCount > 2) {
      return {
        isValid: false,
        reason: 'Potential spam detected'
      };
    }
    
    // Verificar se é muito curto (provavelmente acidente)
    if (content.length < 2) {
      return {
        isValid: false,
        reason: 'Message too short'
      };
    }
    
    // Verificar se é muito longo (possível flood)
    if (content.length > 1000) {
      return {
        isValid: false,
        reason: 'Message too long'
      };
    }
    
    return {
      isValid: true
    };
  }

  // Método para extrair informações do cliente (opcional)
  static extractCustomerInfo(messageContent, customerNumber) {
    const info = {
      phone: customerNumber,
      name: null
    };
    
    // Tentar extrair nome da mensagem (básico)
    const namePatterns = [
      /meu nome é\s+([a-zA-Z\s]+)/i,
      /eu sou\s+([a-zA-Z\s]+)/i,
      /([a-zA-Z\s]+) aqui/i
    ];
    
    for (const pattern of namePatterns) {
      const match = messageContent.match(pattern);
      if (match && match[1]) {
        info.name = match[1].trim();
        break;
      }
    }
    
    return info;
  }
}

module.exports = MessageHandler;
