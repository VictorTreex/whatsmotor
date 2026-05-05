const { createClient } = require('@supabase/supabase-js');
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

class SupabaseService {
  constructor() {
    // Backend admin mode - usar SERVICE_ROLE_KEY para bypassar RLS
    logger.info("Supabase initialized in SERVICE_ROLE backend admin mode");
    
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );
  }

  // ============ SESSÕES WHATSAPP ============
  
  async saveSessionStatus(userId, status, data = {}) {
    try {
      // Mapeamento seguro para colunas válidas da tabela
      const mappedData = {
        status,
        updated_at: new Date().toISOString()
      };
      
      // Mapear campos específicos
      if (data.phone) mappedData.phone_number = data.phone;
      if (data.profile_name) mappedData.profile_name = data.profile_name;
      if (data.qr_code) mappedData.qr_code = data.qr_code;
      if (data.last_activity) mappedData.last_activity_at = data.last_activity;
      
      // Se status = connected, preencher last_connected_at
      if (status === 'connected') {
        mappedData.last_connected_at = new Date().toISOString();
      }
      
      // Payload final para debug
      const payloadFinal = {
        user_id: userId,
        session_name: 'default',
        ...mappedData
      };
      
      logger.info('UPSERT whatsapp_sessions payload:', payloadFinal);
      
      const { data: result, error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert(payloadFinal, {
          onConflict: 'user_id,session_name'
        });

      if (error) {
        logger.error('Error saving session status:', error);
        throw error;
      }

      logger.info(`Session status saved for user ${userId}: ${status}`);
      return result;
    } catch (error) {
      logger.error('Failed to save session status:', error);
      throw error;
    }
  }

  async getSessionStatus(userId) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('session_name', 'default')
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        logger.error('Error getting session status:', error);
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Failed to get session status:', error);
      throw error;
    }
  }

  async updateSessionQR(userId, qrCode) {
    try {
      const payloadFinal = {
        status: 'qr',
        qr_code: qrCode,
        qr_generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      logger.info('UPDATE whatsapp_sessions QR payload:', payloadFinal);
      
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .update(payloadFinal)
        .eq('user_id', userId)
        .eq('session_name', 'default');

      if (error) {
        logger.error('Error updating QR code:', error);
        throw error;
      }

      logger.info(`QR Code updated for user ${userId}`);
      return data;
    } catch (error) {
      logger.error('Failed to update QR code:', error);
      throw error;
    }
  }

  async clearSessionQR(userId) {
    try {
      const payloadFinal = {
        qr_code: null,
        updated_at: new Date().toISOString()
      };
      
      logger.info('UPDATE whatsapp_sessions clear QR payload:', payloadFinal);
      
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .update(payloadFinal)
        .eq('user_id', userId)
        .eq('session_name', 'default');

      if (error) {
        logger.error('Error clearing QR code:', error);
        throw error;
      }

      logger.info(`QR Code cleared for user ${userId}`);
      return data;
    } catch (error) {
      logger.error('Failed to clear QR code:', error);
      throw error;
    }
  }

  // ============ CONFIGURAÇÕES DE AUTO RESPOSTA ============

  async getAutoResponderConfig(userId) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_auto_messages')
        .select('*')
        .eq('store_id', userId)
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error('Error getting auto responder config:', error);
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Failed to get auto responder config:', error);
      throw error;
    }
  }

  // ============ COOLDOWN ============

  async checkCooldown(userId, customerNumber) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_contacts_cooldown')
        .select('last_sent_at')
        .eq('user_id', userId)
        .eq('phone', customerNumber)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error('Error checking cooldown:', error);
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Failed to check cooldown:', error);
      throw error;
    }
  }

  async updateCooldown(userId, customerNumber) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_contacts_cooldown')
        .upsert({
          user_id: userId,
          phone: customerNumber,
          last_sent_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,phone'
        })
        .select()
        .single();

      if (error) {
        logger.error('Error updating cooldown:', error);
        throw error;
      }

      logger.info(`Cooldown updated for user ${userId}, customer ${customerNumber}`);
      return data;
    } catch (error) {
      logger.error('Failed to update cooldown:', error);
      throw error;
    }
  }

  // ============ LOGS DE MENSAGENS ============

  async logMessage(userId, messageData) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_messages')
        .insert({
          user_id: userId,
          ...messageData,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        logger.error('Error logging message:', error);
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Failed to log message:', error);
      throw error;
    }
  }

  async logIncomingMessage(userId, fromNumber, messageContent) {
    return this.logMessage(userId, {
      direction: 'in',
      from_number: fromNumber,
      to_number: 'bot',
      content: messageContent,
      message_type: 'text',
      status: 'received',
      is_auto_reply: false
    });
  }

  async logOutgoingMessage(userId, toNumber, messageContent) {
    return this.logMessage(userId, {
      direction: 'out',
      from_number: 'bot',
      to_number: toNumber,
      content: messageContent,
      message_type: 'text',
      status: 'sent',
      is_auto_reply: true
    });
  }

  // ============ UTILITÁRIOS ============

  async testConnection() {
    try {
      const { data, error } = await this.supabase
        .from('profiles')
        .select('id')
        .limit(1);

      if (error) {
        logger.error('Supabase connection test failed:', error);
        throw new Error('Supabase connection failed - check SERVICE_ROLE_KEY and permissions');
      }

      logger.info('Supabase connection successful with SERVICE_ROLE_KEY');
      return true;
    } catch (error) {
      logger.error('Supabase connection test failed:', error.message);
      throw error;
    }
  }
}

module.exports = SupabaseService;
