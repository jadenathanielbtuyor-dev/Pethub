const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const { API_PREFIXES } = require('./constants/apiRoutes');
const apiNotFoundHandler = require('./middleware/apiNotFoundHandler');
const errorHandler = require('./middleware/errorHandler');
const securityHeaders = require('./middleware/securityHeaders');
const logger = require('./utils/logger');

const app = express();
const PORT = env.port;

// Railway puts one proxy in front of the app; trusting that single hop makes req.ip the visitor's address (used by the
// rate limits in middleware/rateLimit.js) while ignoring any extra X-Forwarded-For entries a client adds itself
app.set('trust proxy', 1);
// Replies do not advertise the server framework
app.disable('x-powered-by');
app.use(securityHeaders);

// Middleware
const allowedOrigins = env.cors.allowedOrigins;

// Preview and branch deployments of PetHub's own Vercel project (pethub-<id>-zzz-duke1-s-projects.vercel.app,
// pethub-git-<branch>-zzz-duke1-s-projects.vercel.app). Other *.vercel.app sites are refused; more origins can be
// added with FRONTEND_URL or CORS_ORIGINS.
const PETHUB_VERCEL_PREVIEW_ORIGIN = /^https:\/\/pethub-[a-z0-9-]+-zzz-duke1-s-projects\.vercel\.app$/;

// The local host itself on any port; "localhost" anywhere in the origin also matched sites such as https://localhost.example.com
function isLocalhostOrigin(origin) {
  try {
    return new URL(origin).hostname === 'localhost';
  } catch (error) {
    return false;
  }
}

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman/mobile apps/local tools)
    if (!origin) return callback(null, true);

    // Allow PetHub's Vercel deployments + localhost
    if (
      allowedOrigins.includes(origin) ||
      PETHUB_VERCEL_PREVIEW_ORIGIN.test(origin) ||
      isLocalhostOrigin(origin)
    ) {
      return callback(null, true);
    }

    // A refused origin is a 403 for the client, not a server error
    const error = new Error('Not allowed by CORS');
    error.status = 403;
    return callback(error);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID'],
  credentials: true
};

// The frontend is also served by this server (static files below), so requests from this
// server's own host are same-origin and always allowed; every other origin uses the rules above.
function isOwnOrigin(req, origin) {
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

const corsOptionsDelegate = (req, callback) => {
  callback(null, {
    ...corsOptions,
    origin: (origin, originCallback) => (
      origin && isOwnOrigin(req, origin)
        ? originCallback(null, true)
        : corsOptions.origin(origin, originCallback)
    )
  });
};

app.use(cors(corsOptionsDelegate));
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const petsRoutes = require('./routes/pets');
const appointmentsRoutes = require('./routes/appointments');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const contactRoutes = require('./routes/contact');

// Explicitly handle OPTIONS for API routes using regex (Express 5 compatible)
API_PREFIXES.forEach(prefix => {
  app.options(new RegExp(`^\\${prefix}`), cors(corsOptionsDelegate));
});

// API routes
app.use('/auth', authRoutes);
app.use('/pets', petsRoutes);
app.use('/appointments', appointmentsRoutes);
app.use('/ai', aiRoutes);
app.use('/admin', adminRoutes);
app.use('/contact', contactRoutes);

// API fallback for unknown and removed API routes (404 for unmatched API calls)
app.use(apiNotFoundHandler);

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// Base route - default homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// 404 handler for non-API routes (serve index for SPA routing)
app.use((req, res) => {
  // Serve index.html for all non-API routes to support SPA routing
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Error handling middleware - MUST be last
app.use(errorHandler);

// Every normal start listens exactly as before; only the automated tests set PETHUB_DISABLE_LISTEN to load the app without a port
if (process.env.PETHUB_DISABLE_LISTEN !== 'true') {
  app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
  });
}

module.exports = app;

