const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
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

class SessionManager {
  constructor() {
    this.sessions = new Map(); // userId -> session data
    this.supabaseService = new SupabaseService();
    
    // Para Railway: usar pasta temporária ou variável de ambiente
    this.authInfoPath = process.env.AUTH_DATA_PATH || path.join(__dirname, 'auth_info');
    
    // Garantir que pasta auth_info exista
    this.ensureAuthFolder();
  }

  async ensureAuthFolder() {
    try {
      await fs.ensureDir(this.authInfoPath);
      logger.info('Auth info folder ensured');
    } catch (error) {
      logger.error('Failed to ensure auth folder:', error);
    }
  }

  getAuthPath(userId) {
    return path.join(this.authInfoPath, userId);
  }

  async startSession(userId) {
    try {
      logger.info(`Starting WhatsApp session for user: ${userId}`);

      // Verificar se já existe sessão ativa
      if (this.sessions.has(userId)) {
        const existingSession = this.sessions.get(userId);
        if (existingSession.status === 'connected') {
          logger.info(`Session already connected for user: ${userId}`);
          return existingSession;
        }
      }

      // Inicializar dados da sessão
      const sessionData = {
        sock: null,
        qr: null,
        status: 'connecting',
        phone: null,
        profileName: null,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5
      };

      this.sessions.set(userId, sessionData);

      // Salvar status inicial no Supabase
      await this.supabaseService.saveSessionStatus(userId, 'connecting');

      // Criar estado de autenticação persistente
      const authPath = this.getAuthPath(userId);
      
      // 🥇 PASSO 1 — limpa sessão
      await fs.remove(authPath);
      await fs.ensureDir(authPath);
      
      logger.info(`Auth state loaded successfully for user: ${userId}`);
      const { state, saveCreds } = await useMultiFileAuthState(authPath);

      // Criar socket Baileys
      logger.info(`Creating Baileys socket with persistent auth state for user: ${userId}`);
      
      // Buscar versão mais recente do Baileys
      const { version, isLatest } = await fetchLatestBaileysVersion();
      logger.info(`Using latest Baileys WA version: ${version} | isLatest: ${isLatest}`);
      
      const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 100,
        keepAliveIntervalMs: 30000,
        browser: ['Windows', 'Chrome', '120.0.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        fireInitQueries: true,
        logger: pino({ level: 'silent' }) // Silenciar logs do Baileys
      });

      // Atualizar sessão com socket
      sessionData.sock = sock;

      // Configurar event listeners
      this.setupEventListeners(userId, sock, saveCreds);

      logger.info(`WhatsApp session started for user: ${userId}`);
      return sessionData;

    } catch (error) {
      logger.error(`Failed to start session for user ${userId}:`, error);
      
      // Atualizar status para erro
      await this.supabaseService.saveSessionStatus(userId, 'error');
      
      // Remover sessão do cache
      this.sessions.delete(userId);
      
      throw error;
    }
  }

  setupEventListeners(userId, sock, saveCreds) {
    const sessionData = this.sessions.get(userId);

    // Evento de atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      // Log detalhado para diagnóstico
      logger.info(`RAW connection.update for ${userId}: ${JSON.stringify({
        connection: update.connection || null,
        hasQr: !!update.qr,
        lastDisconnect: update.lastDisconnect ? {
          errorMessage: update.lastDisconnect.error?.message || null,
          statusCode: update.lastDisconnect.error?.output?.statusCode || null,
          payload: update.lastDisconnect.error || null
        } : null
      }, null, 2)}`);

      logger.info(`Connection update for user ${userId}:`, update);

      try {
        if (update.qr) {
          // QR Code disponível
          logger.info(`QR RECEIVED for user ${userId}`);
          const qrDataUrl = await qrcode.toDataURL(update.qr);
          sessionData.qr = qrDataUrl;
          sessionData.status = 'qr';

          // Salvar QR no Supabase
          await this.supabaseService.updateSessionQR(userId, qrDataUrl);
          
          logger.info(`QR Code generated for user: ${userId}`);
        }

        if (update.connection === 'open') {
          // Conexão estabelecida com sucesso
          // 🥇 PASSO 4 — loga quando conectar de verdade
          logger.info(`🎉 CONNECTION OPEN for user ${userId} - CHEGOU AQUI!!!`);
          const authInfo = sock.user;
          
          sessionData.status = 'connected';
          sessionData.phone = authInfo.id?.replace('@s.whatsapp.net', '') || null;
          sessionData.profileName = authInfo.name || null;
          sessionData.qr = null;
          sessionData.reconnectAttempts = 0;

          // Atualizar status no Supabase
          await this.supabaseService.saveSessionStatus(userId, 'connected', {
            phone: sessionData.phone,
            profile_name: sessionData.profileName,
            qr_code: null,
            last_activity: new Date().toISOString()
          });

          // Limpar QR do Supabase
          await this.supabaseService.clearSessionQR(userId);

          logger.info(`WhatsApp connected for user ${userId} - Phone: ${sessionData.phone}`);
        }

        if (update.connection === 'close') {
          // Conexão fechada
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          logger.info(`CONNECTION CLOSED for user ${userId} - statusCode: ${statusCode}`);
          
          // Tratamento específico para handshake rejeitado
          if (statusCode === 405) {
            logger.error(`Handshake rejected by WhatsApp server for user ${userId} - Browser/Version incompatibility`);
            // Não tentar reconectar imediatamente para evitar loop infinito
            sessionData.reconnectAttempts = sessionData.maxReconnectAttempts;
          }
          
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;

          sessionData.status = 'disconnected';

          // Atualizar status no Supabase
          await this.supabaseService.saveSessionStatus(userId, 'disconnected', {
            last_disconnected_at: new Date().toISOString()
          });

          if (shouldReconnect && sessionData.reconnectAttempts < sessionData.maxReconnectAttempts) {
            sessionData.reconnectAttempts++;
            // 🥇 PASSO 3 — evita loop agressivo
            const delayMs = 5000;
            logger.info(`Attempting to reconnect for user ${userId} (attempt ${sessionData.reconnectAttempts}/${sessionData.maxReconnectAttempts}) - delay: ${delayMs}ms`);
            
            // Tentar reconectar após delay
            setTimeout(() => {
              this.startSession(userId);
            }, delayMs); // Exponential backoff ou 8s para handshake rejected
          } else {
            logger.error(`Max reconnection attempts reached for user ${userId} or logged out`);
            this.sessions.delete(userId);
          }
        }
      } catch (error) {
        logger.error(`Error in connection update for user ${userId}:`, error);
      }
    });

    // Evento de atualização de credenciais
    sock.ev.on('creds.update', saveCreds);

    // Evento de mensagens (delegar para messageHandler)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const MessageHandler = require('./messageHandler');
        await MessageHandler.handleIncomingMessage(m, userId, sock, this.supabaseService);
      } catch (error) {
        logger.error(`Error handling message for user ${userId}:`, error);
      }
    });
  }

  async getSessionStatus(userId) {
    // Primeiro verificar cache
    const cachedSession = this.sessions.get(userId);
    if (cachedSession) {
      return {
        connected: cachedSession.status === 'connected',
        status: cachedSession.status,
        phone: cachedSession.phone,
        profileName: cachedSession.profileName,
        qr: cachedSession.qr
      };
    }

    // Se não estiver em cache, buscar do Supabase
    try {
      const dbSession = await this.supabaseService.getSessionStatus(userId);
      if (dbSession) {
        return {
          connected: dbSession.status === 'connected',
          status: dbSession.status,
          phone: dbSession.phone,
          profileName: dbSession.profile_name,
          qr: dbSession.qr_code
        };
      }
    } catch (error) {
      logger.error(`Failed to get session status from DB for user ${userId}:`, error);
    }

    return {
      connected: false,
      status: 'disconnected',
      phone: null,
      profileName: null,
      qr: null
    };
  }

  async getQRCode(userId) {
    const session = this.sessions.get(userId);
    return session?.qr || null;
  }

  async disconnectSession(userId) {
    try {
      logger.info(`Disconnecting session for user: ${userId}`);

      const session = this.sessions.get(userId);
      if (session?.sock) {
        session.sock.end();
      }

      // Remover do cache
      this.sessions.delete(userId);

      // Atualizar status no Supabase
      await this.supabaseService.saveSessionStatus(userId, 'disconnected', {
        last_disconnected_at: new Date().toISOString()
      });

      logger.info(`Session disconnected for user: ${userId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to disconnect session for user ${userId}:`, error);
      throw error;
    }
  }

  getAllSessions() {
    const sessions = [];
    
    for (const [userId, sessionData] of this.sessions.entries()) {
      sessions.push({
        userId,
        status: sessionData.status,
        phone: sessionData.phone,
        profileName: sessionData.profileName,
        connected: sessionData.status === 'connected'
      });
    }

    return sessions;
  }

  async reconnectAllSessions() {
    logger.info('Attempting to reconnect all sessions...');
    
    for (const [userId, sessionData] of this.sessions.entries()) {
      if (sessionData.status !== 'connected') {
        try {
          await this.startSession(userId);
        } catch (error) {
          logger.error(`Failed to reconnect session for user ${userId}:`, error);
        }
      }
    }
  }

  async cleanup() {
    try {
      logger.info('Starting session cleanup...');
      
      // Limpar sessões desconectadas
      for (const [userId, session] of this.sessions) {
        if (session.status === 'disconnected' || session.status === 'error') {
          this.sessions.delete(userId);
          logger.info(`Cleaned up session for user: ${userId}`);
        }
      }
      
      // Limpar pastas de autenticação antigas
      await this.cleanupOldAuthFolders();
      
      logger.info('Session cleanup completed');
    } catch (error) {
      logger.error('Failed to cleanup sessions:', error);
    }
  }

  getSessionCount() {
    return this.sessions.size;
  }

  async reconnectDisconnectedSessions() {
    try {
      logger.info('Checking disconnected sessions for reconnection...');
      
      for (const [userId, session] of this.sessions) {
        if (session.status === 'disconnected' && session.reconnectAttempts < session.maxReconnectAttempts) {
          logger.info(`Attempting to reconnect session for user: ${userId}`);
          await this.startSession(userId);
        }
      }
    } catch (error) {
      logger.error('Failed to reconnect sessions:', error);
    }
  }

  async cleanupOldAuthFolders() {
    try {
      const authFolder = this.authInfoPath;
      const folders = await fs.readdir(authFolder);
      
      for (const folder of folders) {
        const sessionPath = path.join(authFolder, folder);
        const stats = await fs.stat(sessionPath);
        
        // Se for pasta e não estiver ativa há mais de 7 dias, remover
        if (stats.isDirectory() && !this.sessions.has(folder)) {
          const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
          
          if (stats.mtimeMs < sevenDaysAgo) {
            await fs.remove(sessionPath);
            logger.info(`Cleaned up old auth folder: ${folder}`);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old sessions:', error);
    }
  }
}

module.exports = SessionManager;
