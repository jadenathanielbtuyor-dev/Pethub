const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const { API_PREFIXES } = require('./constants/apiRoutes');
const apiNotFoundHandler = require('./middleware/apiNotFoundHandler');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

const app = express();
const PORT = env.port;

// Middleware
const allowedOrigins = env.cors.allowedOrigins;

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman/mobile apps/local tools)
    if (!origin) return callback(null, true);

    // Allow Vercel deployments + localhost
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost')
    ) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
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

