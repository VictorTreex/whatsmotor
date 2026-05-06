const pino = require('pino');
const SupabaseService = require('./supabaseService');

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
  
  // ✅ CACHE — Mapa para resolver LID->telefone
  static jidCache = new Map(); // LID -> telefone válido

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

  // ✅ FUNÇÃO — Resolve JID com 5 níveis de fallback (NÍVEL PRO)
  static async resolveJid(message, userId, supabaseService, sock = null) {
    const rawJid = message.key.remoteJid;
    
    if (!rawJid) {
      logger.warn('❌ No remoteJid in message');
      return null;
    }

    logger.info(`📌 Resolving JID: ${rawJid}`);

    // 🔥 NOVO NÍVEL 0 — Contacts do Baileys (fonte mais forte)
    if (sock?.contacts && Object.keys(sock.contacts).length > 0) {
      const contact = Object.values(sock.contacts).find(c => c.id === rawJid);
      if (contact?.id?.endsWith('@s.whatsapp.net')) {
        this.jidCache.set(rawJid, contact.id);
        logger.info(`🔥 Nível 0: Contacts Baileys resolvido: ${contact.id}`);
        return contact.id;
      }
    }

    // 🥇 NÍVEL 1 — JID direto (mais confiável)
    if (rawJid.endsWith('@s.whatsapp.net')) {
      this.jidCache.set(rawJid, rawJid);
      
      // ✅ SALVAR NO BANCO - aprende novo contato
      try {
        const cleanPhone = SupabaseService.cleanPhone(rawJid);
        await supabaseService.supabase
          .from('jid_map')
          .upsert({
            lid: rawJid,
            phone: cleanPhone,
            user_id: userId
          }, {
            onConflict: 'lid,user_id'
          });
        logger.info(`💾 Banco salvo: ${rawJid} -> ${cleanPhone}`);
      } catch (saveError) {
        logger.warn(`⚠️ Erro ao salvar no banco: ${saveError.message}`);
      }
      
      logger.info(`✅ Nível 1: JID direto resolvido: ${rawJid}`);
      return rawJid;
    }

    // 🥈 NÍVEL 2 — participant (muito importante para grupos)
    if (message.key.participant?.endsWith('@s.whatsapp.net')) {
      const participantJid = message.key.participant;
      this.jidCache.set(rawJid, participantJid);
      
      // ✅ SALVAR NO BANCO - aprende novo contato
      try {
        const cleanPhone = SupabaseService.cleanPhone(participantJid);
        await supabaseService.supabase
          .from('jid_map')
          .upsert({
            lid: rawJid,
            phone: cleanPhone,
            user_id: userId
          }, {
            onConflict: 'lid,user_id'
          });
        logger.info(`💾 Banco salvo (participant): ${rawJid} -> ${cleanPhone}`);
      } catch (saveError) {
        logger.warn(`⚠️ Erro ao salvar participant no banco: ${saveError.message}`);
      }
      
      logger.info(`✅ Nível 2: Participant resolvido: ${participantJid}`);
      return participantJid;
    }

    // 🥉 NÍVEL 3 — Cache de contatos
    if (this.jidCache.has(rawJid)) {
      const cachedJid = this.jidCache.get(rawJid);
      logger.info(`✅ Nível 3: Cache resolvido: ${cachedJid}`);
      return cachedJid;
    }

    // NÍVEL 3.5 — Persistência no banco (tabela jid_map)
    if (rawJid.includes('@lid')) {
      try {
        logger.info(`🔍 Buscando LID no banco: ${rawJid}`);
        
        const { data } = await supabaseService.supabase
          .from('jid_map')
          .select('phone')
          .eq('lid', rawJid)
          .eq('user_id', userId)
          .single();

        if (data?.phone) {
          // ✅ Limpar phone usando função utilitária
          let phone = SupabaseService.cleanPhone(data.phone);
          
          // ✅ Blindagem contra duplicação de @s.whatsapp.net
          const phoneJid = phone.includes('@s.whatsapp.net')
            ? phone
            : `${phone}@s.whatsapp.net`;
          
          this.jidCache.set(rawJid, phoneJid);
          logger.info(`✅ Banco resolveu LID: ${phoneJid}`);
          return phoneJid;
        } else {
          logger.warn(`❌ LID não encontrado no banco: ${rawJid}`);
        }
      } catch (dbError) {
        logger.warn(`❌ Erro ao buscar no banco: ${dbError.message}`);
      }
    }

    // 🧩 NÍVEL 4 — jidDecode (tentativa inteligente)
    try {
      const { jidDecode } = require('@whiskeysockets/baileys');
      const decoded = jidDecode(rawJid);

      if (decoded?.user) {
        const decodedJid = `${decoded.user}@s.whatsapp.net`;
        this.jidCache.set(rawJid, decodedJid);
        
        // ✅ SALVAR NO BANCO - aprende novo contato
        try {
          // ✅ Limpar decoded.user para remover caracteres não numéricos
          const cleanPhone = decoded.user.replace(/\D/g, '');
          await supabaseService.supabase
            .from('jid_map')
            .upsert({
              lid: rawJid,
              phone: cleanPhone,
              user_id: userId
            }, {
              onConflict: 'lid,user_id'
            });
          logger.info(`💾 Banco salvo (decode): ${rawJid} -> ${cleanPhone}`);
        } catch (saveError) {
          logger.warn(`⚠️ Erro ao salvar decode no banco: ${saveError.message}`);
        }
        
        logger.info(`✅ Nível 4: JID decode resolvido: ${decodedJid}`);
        return decodedJid;
      }
    } catch (decodeError) {
      logger.warn(`⚠️ JID decode failed: ${decodeError.message}`);
    }

    // 🧨 NÍVEL 5 — Fallback final (ignorar LID desconhecido)
    if (rawJid.includes('@lid')) {
      logger.warn(`❌ Nível 5: LID desconhecido, ignorando: ${rawJid}`);
      return null;
    }

    // Formato desconhecido
    logger.warn(`❌ Formato JID desconhecido: ${rawJid}`);
    return null;
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

      // ✅ PASSO 3 — Resolver JID com estratégia completa (NÍVEL PRO)
      const resolvedJid = await this.resolveJid(message, userId, supabaseService, sock);
      
      if (!resolvedJid) {
        logger.warn(`❌ Não foi possível resolver JID: ${message.key.remoteJid}`);
        return;
      }
      
      // Extrair número do JID resolvido para logs compatíveis
      const customerNumber = SupabaseService.cleanPhone(resolvedJid);
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
      logger.info("DEBUG STEP 1 - chegou no auto responder");
      
      const autoResponderConfig = await supabaseService.getAutoResponderConfig(
        userId,
        message.key.remoteJid
      );

      logger.info("DEBUG STEP 2 - config:", autoResponderConfig);
      
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
      logger.info(`📤 Sending welcome auto reply to ${customerNumber} for user ${userId}`);
      logger.info(`📋 Send details: JID=${resolvedJid}, Attempt=1, MaxRetries=2, MessageLength=${autoReplyText.length}`);
      
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
        await this.safeSend(sock, resolvedJid, autoReplyText);
        
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
        
        // 🔥 MELHORIA PRO - Salvar JID quando envia (aprendizado)
        try {
          await supabaseService.supabase
            .from('jid_map')
            .upsert({
              lid: resolvedJid,
              phone: customerNumber,
              user_id: userId
            }, {
              onConflict: 'lid,user_id'
            });
          logger.info(`🧠 Aprendizado: ${resolvedJid} -> ${customerNumber}`);
        } catch (learnError) {
          logger.warn(`⚠️ Erro ao salvar aprendizado: ${learnError.message}`);
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
