const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Configuração do Socket.io (O Carteiro)
const io = new Server(server, {
    cors: {
        origin: "*", // Libera geral (Netlify, Itch.io, Localhost)
        methods: ["GET", "POST"]
    }
});

let players = {};

io.on('connection', (socket) => {
    console.log('Novo jogador conectado:', socket.id);

    // 1. Quando alguém entra
    socket.on('join', (userData) => {
        players[socket.id] = {
            id: socket.id,
            name: userData.name,
            x: 0, y: 0, z: 0, ry: 0
        };
        
        // Avisa os outros que você entrou
        socket.broadcast.emit('playerJoined', { id: socket.id, name: userData.name });
        
        // Te avisa quem já estava na sala
        socket.emit('currentPlayers', players);
    });

    // 2. Quando alguém se mexe
    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            players[socket.id].ry = data.ry;
            
            // Manda a nova posição para todos (menos pra você mesmo)
            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                pos: data 
            });
        }
    });

    // 3. Chat
    socket.on('chat', (msg) => {
        socket.broadcast.emit('chatMessage', { id: socket.id, msg: msg });
    });

    // 4. Eventos do Jogo (Start, Lanterna, etc)
    socket.on('gameEvent', (payload) => {
        socket.broadcast.emit('gameEvent', payload);
    });

    // 5. Tchau
    socket.on('disconnect', () => {
        console.log('Jogador saiu:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// A porta que o servidor vai ouvir (Render usa a variável PORT, local usa 3000)
// O Render injeta a porta automaticamente em process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`SERVIDOR RODANDO NA PORTA ${PORT}`);
});