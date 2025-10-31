// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Configure based on your needs
}));

// CORS configuration
const corsOptions = {
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

app.use(express.json());
app.use(express.static('public'));

// Socket.IO setup with security
const io = new Server(server, {
  cors: corsOptions,
  maxHttpBufferSize: 1e6, // 1MB max message size
  pingTimeout: 60000,
  pingInterval: 25000
});

// In-memory store (use Redis in production for multiple servers)
const users = new Map();
const rooms = new Map();
const messageHistory = new Map();

// Middleware for socket authentication
io.use((socket, next) => {
  const username = socket.handshake.auth.username;
  const room = socket.handshake.auth.room || 'general';
  
  if (!username || username.trim().length === 0) {
    return next(new Error('Invalid username'));
  }
  
  if (username.length > 50) {
    return next(new Error('Username too long'));
  }
  
  socket.username = username.trim();
  socket.room = room.trim();
  next();
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.username} (${socket.id})`);
  
  // Store user info
  users.set(socket.id, {
    username: socket.username,
    room: socket.room,
    joinedAt: Date.now()
  });
  
  // Join room
  socket.join(socket.room);
  
  // Initialize room if needed
  if (!rooms.has(socket.room)) {
    rooms.set(socket.room, new Set());
    messageHistory.set(socket.room, []);
  }
  rooms.get(socket.room).add(socket.id);
  
  // Send message history
  const history = messageHistory.get(socket.room) || [];
  socket.emit('message_history', history.slice(-50)); // Last 50 messages
  
  // Notify room of new user
  socket.to(socket.room).emit('user_joined', {
    username: socket.username,
    timestamp: Date.now(),
    userCount: rooms.get(socket.room).size
  });
  
  // Send updated user list
  broadcastUserList(socket.room);
  
  // Handle incoming messages
  socket.on('send_message', (data) => {
    try {
      const message = String(data.message || '').trim();
      
      if (!message || message.length === 0) return;
      if (message.length > 1000) {
        socket.emit('error', { message: 'Message too long' });
        return;
      }
      
      const messageData = {
        id: `${socket.id}-${Date.now()}`,
        username: socket.username,
        message: message,
        timestamp: Date.now(),
        room: socket.room
      };
      
      // Store message
      const history = messageHistory.get(socket.room);
      history.push(messageData);
      if (history.length > 100) {
        history.shift(); // Keep only last 100 messages
      }
      
      // Broadcast to room
      io.to(socket.room).emit('new_message', messageData);
      
    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle typing indicator
  socket.on('typing', () => {
    socket.to(socket.room).emit('user_typing', {
      username: socket.username
    });
  });
  
  socket.on('stop_typing', () => {
    socket.to(socket.room).emit('user_stop_typing', {
      username: socket.username
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.username} (${socket.id})`);
    
    const user = users.get(socket.id);
    if (user) {
      const room = user.room;
      
      // Remove from room
      if (rooms.has(room)) {
        rooms.get(room).delete(socket.id);
        if (rooms.get(room).size === 0) {
          rooms.delete(room);
          messageHistory.delete(room);
        }
      }
      
      // Notify room
      socket.to(room).emit('user_left', {
        username: user.username,
        timestamp: Date.now(),
        userCount: rooms.has(room) ? rooms.get(room).size : 0
      });
      
      broadcastUserList(room);
    }
    
    users.delete(socket.id);
  });
});

// Helper function to broadcast user list
function broadcastUserList(room) {
  const userList = [];
  if (rooms.has(room)) {
    rooms.get(room).forEach(socketId => {
      const user = users.get(socketId);
      if (user) {
        userList.push({
          username: user.username,
          joinedAt: user.joinedAt
        });
      }
    });
  }
  io.to(room).emit('user_list', userList);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    connections: users.size,
    rooms: rooms.size
  });
});

// Stats endpoint (optional, can add authentication)
app.get('/stats', (req, res) => {
  res.json({
    totalUsers: users.size,
    totalRooms: rooms.size,
    roomDetails: Array.from(rooms.entries()).map(([room, userIds]) => ({
      room,
      users: userIds.size
    }))
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});