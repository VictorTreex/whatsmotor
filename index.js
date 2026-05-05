require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const Routes = require('./routes');
const SessionManager = require('./sessionManager');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  }
});

class WhatsAppEngineServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT; // Railway define PORT automaticamente
    
    // Singleton: Criar UMA única instância global de SessionManager
    this.sessionManager = new SessionManager();
    
    // Injetar dependência no Routes (não criar nova instância)
    this.routes = new Routes(this.sessionManager);
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // CORS - Configurado para Railway e frontend
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || [
        process.env.FRONTEND_URL || 'https://www.treexonline.online',
        'http://localhost:3000',
        'https://localhost:3000'
      ],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-client-info'],
      credentials: true
    }));

    // Body parser
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} - IP: ${req.ip} - User-Agent: ${req.get('User-Agent') || 'unknown'}`);
      next();
    });
  }

  setupRoutes() {
    // API routes
    this.app.use('/api/whatsapp', this.routes.getRouter());

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        success: true,
        data: {
          service: 'FrodFast WhatsApp Engine - Railway Ready',
          version: '1.0.0',
          status: 'running',
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV || 'production',
          endpoints: {
            connect: 'POST /api/whatsapp/connect/:userId',
            status: 'GET /api/whatsapp/status/:userId',
            qr: 'GET /api/whatsapp/qr/:userId',
            disconnect: 'POST /api/whatsapp/disconnect/:userId',
            sessions: 'GET /api/whatsapp/sessions',
            reconnect: 'POST /api/whatsapp/reconnect/:userId',
            reconnectAll: 'POST /api/whatsapp/reconnect-all',
            health: 'GET /api/whatsapp/health',
            cleanup: 'POST /api/whatsapp/cleanup'
          }
        }
      });
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        success: true,
        data: {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
          },
          sessions: this.sessionManager.getSessionCount(),
          environment: process.env.NODE_ENV || 'production'
        }
      });
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        code: 'NOT_FOUND',
        path: req.originalUrl
      });
    });
  }

  setupErrorHandling() {
    // Global error handler
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      
      res.status(err.status || 500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
        code: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });
  }

  async start() {
    try {
      logger.info('🚀 Starting FrodFast WhatsApp Engine - Railway Ready...');
      
      // Log environment info
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
      logger.info(`🔗 Port: ${this.port || 'Railway Auto'}`);
      logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'https://www.treexonline.online'}`);
      
      // Testar conexão com Supabase (não crítico para iniciar)
      try {
        const SupabaseService = require('./supabaseService');
        const supabaseService = new SupabaseService();
        await supabaseService.testConnection();
        logger.info('✅ Supabase connection successful');
      } catch (error) {
        logger.warn('⚠️ Supabase connection failed, but continuing startup:', error.message);
      }
      
      // Iniciar servidor com bind para Railway (0.0.0.0)
      this.server = this.app.listen(this.port || 0, '0.0.0.0', () => {
        const actualPort = this.server.address().port;
        logger.info(`✅ WhatsApp Engine started successfully on port ${actualPort}`);
        logger.info(`📡 API available at: http://0.0.0.0:${actualPort}/api/whatsapp`);
        logger.info(`🏥 Health check at: http://0.0.0.0:${actualPort}/health`);
        logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
        logger.info(`🚀 Railway Ready - Multi-tenant WhatsApp Engine`);
      });

      // Graceful shutdown
      this.setupGracefulShutdown();

      // Cleanup periódico
      this.setupPeriodicCleanup();

      // Reconexão automática de sessões
      this.setupAutoReconnect();

    } catch (error) {
      logger.error('❌ Failed to start WhatsApp Engine:', error);
      process.exit(1);
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      logger.info(`🛑 Received ${signal}, shutting down gracefully...`);
      
      // Parar de aceitar novas conexões
      if (this.server) {
        this.server.close(async () => {
          logger.info('📡 HTTP server closed');
          
          // Limpar sessões WhatsApp
          try {
            await this.sessionManager.cleanup();
            logger.info('🧹 WhatsApp sessions cleaned up');
          } catch (error) {
            logger.error('Error cleaning up sessions:', error);
          }
          
          process.exit(0);
        });
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  setupPeriodicCleanup() {
    // Cleanup a cada 30 minutos
    setInterval(async () => {
      try {
        await this.sessionManager.cleanup();
        logger.info('🧹 Periodic cleanup completed');
      } catch (error) {
        logger.error('Error during periodic cleanup:', error);
      }
    }, 30 * 60 * 1000); // 30 minutos
  }

  setupAutoReconnect() {
    // Tentar reconectar sessões desconectadas a cada 5 minutos
    setInterval(async () => {
      try {
        await this.sessionManager.reconnectDisconnectedSessions();
        logger.info('🔄 Auto-reconnect check completed');
      } catch (error) {
        logger.error('Error during auto-reconnect:', error);
      }
    }, 5 * 60 * 1000); // 5 minutos
  }
}

// Iniciar servidor
const server = new WhatsAppEngineServer();
server.start().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

module.exports = WhatsAppEngineServer;
