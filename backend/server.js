require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
const allowedOrigins = [
  'https://pethub-beige.vercel.app',
  'https://pethub-zzz-duke1-s-projects.vercel.app',
  'https://pethub-git-main-zzz-duke1-s-projects.vercel.app',
  'https://pethub-jxb3zsszt-zzz-duke1-s-projects.vercel.app'
];

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

app.use(cors(corsOptions));
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const petsRoutes = require('./routes/pets');
const appointmentsRoutes = require('./routes/appointments');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const contactRoutes = require('./routes/contact');

// Explicitly handle OPTIONS for API routes using regex (Express 5 compatible)
app.options(/^\/auth/, cors(corsOptions));
app.options(/^\/pets/, cors(corsOptions));
app.options(/^\/appointments/, cors(corsOptions));
app.options(/^\/ai/, cors(corsOptions));
app.options(/^\/admin/, cors(corsOptions));
app.options(/^\/contact/, cors(corsOptions));

// API routes
app.use('/auth', authRoutes);
app.use('/pets', petsRoutes);
app.use('/appointments', appointmentsRoutes);
app.use('/ai', aiRoutes);
app.use('/admin', adminRoutes);
app.use('/contact', contactRoutes);

app.listen(PORT, () => {
  console.log(`PetHub backend running on port ${PORT}`);
});

// API fallback for unknown API routes (404 for unmatched API calls)
app.use((req, res, next) => {
  const apiPrefixes = ['/auth', '/pets', '/appointments', '/ai', '/admin'];
  if (apiPrefixes.some(prefix => req.path.startsWith(prefix))) {
    return res.status(404).json({ success: false, error: 'API endpoint not found' });
  }
  next();
});

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
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // Ensure we always return JSON
  if (!res.headersSent) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message || 'Internal Server Error'
    });
  }
});


