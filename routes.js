const express = require('express');
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

class Routes {
  constructor(sessionManager) {
    // Injeção de dependência - receber SessionManager existente
    this.sessionManager = sessionManager;
    this.router = express.Router();
    this.setupRoutes();
  }

  setupRoutes() {
    // Middleware para logging apenas
    this.router.use((req, res, next) => {
      const clientIp = req.ip || req.connection.remoteAddress;
      
      logger.info(`${req.method} ${req.path} - IP: ${clientIp}`);
      
      next();
    });

    // POST /connect/:userId - Iniciar nova sessão
    this.router.post('/connect/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        
        // Validação local de userId
        if (!userId) {
          return res.status(400).json({
            success: false,
            error: 'userId is required',
            code: 'MISSING_USER_ID'
          });
        }
        
        if (typeof userId !== 'string' || userId.length < 3) {
          return res.status(400).json({
            success: false,
            error: 'Invalid userId format',
            code: 'INVALID_USER_ID'
          });
        }

        logger.info(`🚀 Connecting WhatsApp for user: ${userId}`);
        const session = await this.sessionManager.startSession(userId);

        res.json({
          success: true,
          data: {
            connected: false,
            status: session.status,
            message: 'Connection started. Please wait for QR code.'
          }
        });

      } catch (error) {
        logger.error('Connect error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to start connection'
        });
      }
    });

    // GET /status/:userId - Obter status da sessão
    this.router.get('/status/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        
        // Validação local de userId
        if (!userId) {
          return res.status(400).json({
            success: false,
            error: 'userId is required',
            code: 'MISSING_USER_ID'
          });
        }
        
        if (typeof userId !== 'string' || userId.length < 3) {
          return res.status(400).json({
            success: false,
            error: 'Invalid userId format',
            code: 'INVALID_USER_ID'
          });
        }

        const status = await this.sessionManager.getSessionStatus(userId);
        res.json({
          success: true,
          data: status
        });

      } catch (error) {
        logger.error('Status error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to get status'
        });
      }
    });

    // GET /qr/:userId - Obter QR code
    this.router.get('/qr/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        
        // Validação local de userId
        if (!userId) {
          return res.status(400).json({
            success: false,
            error: 'userId is required',
            code: 'MISSING_USER_ID'
          });
        }
        
        if (typeof userId !== 'string' || userId.length < 3) {
          return res.status(400).json({
            success: false,
            error: 'Invalid userId format',
            code: 'INVALID_USER_ID'
          });
        }

        const qrCode = await this.sessionManager.getQRCode(userId);

        if (!qrCode) {
          return res.json({
            success: true,
            data: {
              qr: null,
              message: 'No QR code available. Connection may be complete or not started.'
            }
          });
        }

        res.json({
          success: true,
          data: {
            qr: qrCode
          }
        });

      } catch (error) {
        logger.error('QR error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to get QR code'
        });
      }
    });

    // POST /disconnect/:userId - Desconectar sessão
    this.router.post('/disconnect/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        
        // Validação local de userId
        if (!userId) {
          return res.status(400).json({
            success: false,
            error: 'userId is required',
            code: 'MISSING_USER_ID'
          });
        }
        
        if (typeof userId !== 'string' || userId.length < 3) {
          return res.status(400).json({
            success: false,
            error: 'Invalid userId format',
            code: 'INVALID_USER_ID'
          });
        }

        logger.info(`🔌 Disconnecting WhatsApp for user: ${userId}`);
        await this.sessionManager.disconnectSession(userId);

        res.json({
          success: true,
          data: {
            connected: false,
            status: 'disconnected',
            message: 'Session disconnected successfully'
          }
        });

      } catch (error) {
        logger.error('Disconnect error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to disconnect'
        });
      }
    });

    // POST /reconnect/:userId - Reconectar sessão específica
    this.router.post('/reconnect/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        
        // Validação local de userId
        if (!userId) {
          return res.status(400).json({
            success: false,
            error: 'userId is required',
            code: 'MISSING_USER_ID'
          });
        }
        
        if (typeof userId !== 'string' || userId.length < 3) {
          return res.status(400).json({
            success: false,
            error: 'Invalid userId format',
            code: 'INVALID_USER_ID'
          });
        }

        logger.info(`🔄 Reconnecting WhatsApp for user: ${userId}`);

        // Primeiro desconectar se existir
        await this.sessionManager.disconnectSession(userId);
        
        // Pequeno delay antes de reconectar
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Iniciar nova conexão
        const session = await this.sessionManager.startSession(userId);

        res.json({
          success: true,
          data: {
            connected: false,
            status: session.status,
            message: 'Reconnection started'
          }
        });

      } catch (error) {
        logger.error('Reconnect error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to reconnect'
        });
      }
    });

    // GET /sessions - Listar todas as sessões
    this.router.get('/sessions', async (req, res) => {
      try {
        const sessions = this.sessionManager.getAllSessions();

        res.json({
          success: true,
          data: {
            sessions: sessions,
            total: sessions.length
          }
        });

      } catch (error) {
        logger.error('Sessions list error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to list sessions'
        });
      }
    });

    // POST /reconnect-all - Reconectar todas as sessões
    this.router.post('/reconnect-all', async (req, res) => {
      try {
        logger.info(`🔄 Reconnecting all sessions`);
        await this.sessionManager.reconnectAllSessions();

        res.json({
          success: true,
          data: {
            message: 'Reconnection process started for all sessions'
          }
        });

      } catch (error) {
        logger.error('Reconnect all error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to reconnect all sessions'
        });
      }
    });

    // GET /health - Health check do serviço
    this.router.get('/health', async (req, res) => {
      try {
        const sessions = this.sessionManager.getAllSessions();
        
        res.json({
          success: true,
          data: {
            status: 'healthy',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            activeSessions: sessions.length,
            connectedSessions: sessions.filter(s => s.connected).length,
            timestamp: new Date().toISOString()
          }
        });

      } catch (error) {
        logger.error('Health check error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Health check failed'
        });
      }
    });

    // POST /save-config/:userId - Salvar configuração de auto resposta
    this.router.post('/save-config/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const { message_text, is_active } = req.body;
        
        logger.info(`💾 Saving WhatsApp auto responder config for user: ${userId}`);
        
        const { data, error } = await this.sessionManager.supabaseService.supabase
          .from('whatsapp_auto_messages')
          .upsert({
            store_id: userId,
            message_text,
            is_active: is_active !== false
          }, {
            onConflict: 'store_id'
          })
          .select()
          .single();
          
        if (error) throw error;
        
        logger.info(`✅ WhatsApp auto responder config saved successfully for user: ${userId}`);
        res.json({ success: true, data });
      } catch (error) {
        logger.error('Error saving WhatsApp config:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // POST /cleanup - Limpar sessões antigas
    this.router.post('/cleanup', async (req, res) => {
      try {
        logger.info(`🧹 Starting cleanup process`);
        await this.sessionManager.cleanupOldSessions();

        res.json({
          success: true,
          data: {
            message: 'Cleanup completed successfully'
          }
        });

      } catch (error) {
        logger.error('Cleanup error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to cleanup'
        });
      }
    });

    // Middleware para tratamento de erros
    this.router.use((error, req, res, next) => {
      logger.error('Unhandled route error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    });

    // Middleware para rotas não encontradas
    this.router.use((req, res) => {
      res.status(404).json({
        success: false,
        error: 'Route not found'
      });
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = Routes;
