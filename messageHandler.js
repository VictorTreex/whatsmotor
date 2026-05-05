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
  static async handleIncomingMessage(m, userId, sock, supabaseService) {
    try {
      logger.info(`📩 EVENT messages.upsert received`);
      const message = m.messages[0];
      
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

      const customerNumber = message.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown';

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

      // 4. Verificar cooldown
      const cooldownData = await supabaseService.checkCooldown(userId, customerNumber);
      
      if (cooldownData?.last_sent_at) {
        const cooldownTime = new Date(cooldownData.last_sent_at);
        cooldownTime.setHours(cooldownTime.getHours() + cooldownHours);
        
        if (new Date() < cooldownTime) {
          logger.info(`⏰ Customer in cooldown for user ${userId}, customer ${customerNumber}. Next reply at: ${cooldownTime}`);
          return; // Ainda em cooldown
        }
      }

      // 5. Logar mensagem recebida
      await supabaseService.logIncomingMessage(userId, customerNumber, messageContent);

      // 6. Enviar resposta automática
      logger.info(`📤 Sending welcome auto reply to ${customerNumber} for user ${userId}`);
      
      try {
        await sock.sendMessage(customerNumber + '@s.whatsapp.net', {
          text: autoReplyText
        });
        
        logger.info(`✅ Welcome auto reply sent successfully to ${customerNumber}`);
        
        // 7. Logar mensagem enviada
        await supabaseService.logOutgoingMessage(userId, customerNumber, autoReplyText);
        
        // 8. Atualizar cooldown
        await supabaseService.updateCooldown(userId, customerNumber);
        
        logger.info(`🎉 Auto reply process completed for user ${userId}, customer ${customerNumber}`);
        
      } catch (sendError) {
        logger.error(`❌ Auto reply send failed to ${customerNumber}:`, sendError);
        
        // Logar erro de envio
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
        
        throw sendError;
      }

    } catch (error) {
      logger.error(`💥 Error handling message for user ${userId}:`, error);
      
      // Opcional: notificar sobre erro no processamento
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
        logger.error('Failed to log error message:', logError);
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
