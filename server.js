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

// =============== SISTEMA DE SALAS ===============
let rooms = {}; // { roomId: { name, password, players: {}, createdAt } }
let playerRooms = {}; // { socketId: roomId }

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

function updateRoomList() {
    // Emite lista de salas para TODOS os clientes
    const roomList = Object.values(rooms)
        .filter(room => room.players && room.players.length > 0) // Só salas com players
        .map(room => ({
            roomId: room.id,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: 10, // ✅ Adicionado limite
            hasPassword: !!room.password,
            createdAt: room.createdAt
        }));
    
    console.log('📢 updateRoomList enviando:', roomList);
    console.log('📊 Salas no servidor:', rooms);
    
    io.emit('roomList', roomList);
}

// =============== EVENTO: CREATE ROOM ===============
io.on('connection', (socket) => {
    console.log('🔌 Novo jogador conectado:', socket.id);

    socket.on('createRoom', (data) => {
        const { roomName, password, nickname } = data;
        
        console.log('🎮 Recebido createRoom:', { roomName, password, nickname });
        
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: roomName,
            password: password || null,
            players: [{ id: socket.id, name: nickname || 'Desconhecido' }],
            createdAt: new Date()
        };
        
        rooms[roomId] = room;
        playerRooms[socket.id] = roomId;
        
        // Socket entra na room do lado do servidor
        socket.join(roomId);
        
        console.log(`✅ Sala criada: ${roomName} (${roomId}) por ${nickname || 'Desconhecido'}`);
        console.log(`📊 Rooms agora:`, Object.keys(rooms));
        console.log(`📊 Room details:`, room);
        
        // Avisa o criador que entrou
        socket.emit('roomCreated', {
            roomId: roomId,
            roomName: roomName,
            players: room.players
        });
        
        // Atualiza lista de salas para TODOS
        console.log('📢 Chamando updateRoomList()');
        updateRoomList();
    });

    // =============== EVENTO: JOIN ROOM ===============
    socket.on('joinRoom', (data) => {
        const { roomId, password, nickname } = data;
        
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Sala não encontrada');
            return;
        }
        
        // ✅ Verifica se a sala já está cheia (máximo 10 jogadores)
        if (room.players.length >= 10) {
            socket.emit('error', 'Sala Cheia (10/10)!');
            return;
        }
        
        // ✅ Verifica senha com conversão para string
        if (room.password && String(room.password) !== String(password)) {
            socket.emit('error', 'Senha incorreta');
            return;
        }
        
        // Adiciona player à sala
        room.players.push({ id: socket.id, name: nickname || 'Desconhecido' });
        playerRooms[socket.id] = roomId;
        
        // Socket entra na room
        socket.join(roomId);
        
        console.log(`✅ ${nickname || 'Desconhecido'} entrou na sala ${room.name}`);
        
        // Avisa pra todos na sala que alguém entrou
        io.to(roomId).emit('playerJoined', {
            id: socket.id,
            name: nickname || 'Desconhecido'
        });
        
        // Avisa o novo player quem já tá na sala
        socket.emit('joinedRoom', {
            roomId: roomId,
            players: room.players,
            roomName: room.name
        });
        
        // Atualiza lista de salas
        updateRoomList();
    });

    // =============== EVENTO: GET ROOMS ===============
    socket.on('getRooms', () => {
        console.log('📋 Cliente pediu lista de salas, salas existentes:', Object.keys(rooms));
        
        const roomList = Object.values(rooms)
            .filter(room => room.players && room.players.length > 0)
            .map(room => ({
                roomId: room.id,
                name: room.name,
                playerCount: room.players.length,
                maxPlayers: 10, // ✅ Adicionado limite
                hasPassword: !!room.password,
                createdAt: room.createdAt
            }));
        
        console.log('📋 Enviando lista de salas:', roomList);
        socket.emit('roomList', roomList);
    });

    // =============== EVENTO: JOIN GAME ===============
    socket.on('join', (userData) => {
        const roomId = playerRooms[socket.id];
        if (!roomId) return;
        
        const room = rooms[roomId];
        if (!room) return;
        
        // Atualiza dados do player
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.x = 0;
            player.y = 0;
            player.z = 0;
            player.ry = 0;
        }
        
        // Emite para TODA A SALA
        io.to(roomId).emit('playerJoined', { id: socket.id, name: userData.name });
        socket.emit('currentPlayers', room.players);
    });

    // =============== EVENTO: MOVE ===============
    socket.on('move', (data) => {
        const roomId = playerRooms[socket.id];
        if (!roomId) return;
        
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.x = data.x;
            player.y = data.y;
            player.z = data.z;
            player.ry = data.ry;
        }
        
        // Manda posição para TODA A SALA (menos pra você)
        socket.to(roomId).emit('playerMoved', {
            id: socket.id,
            pos: data
        });
    });

    // =============== EVENTO: CHAT ===============
    socket.on('chat', (data) => {
        const roomId = playerRooms[socket.id];
        if (!roomId) return;
        
        // Emite só pra SALA
        io.to(roomId).emit('chatMessage', {
            id: socket.id,
            msg: data.msg,
            isDead: data.isDead || false
        });
    });

    // =============== EVENTO: GAME EVENT ===============
    socket.on('gameEvent', (payload) => {
        const roomId = playerRooms[socket.id];
        if (!roomId) return;
        
        if (!payload.playerId) {
            payload.playerId = socket.id;
        }
        
        // Emite pra TODA A SALA
        io.to(roomId).emit('gameEvent', payload);
    });

    // =============== EVENTO: SKIN CHANGE ===============
    socket.on('skinChange', (data) => {
        const roomId = playerRooms[socket.id];
        if (!roomId) return;
        
        io.to(roomId).emit('skinChange', {
            id: socket.id,
            skinId: data.skinId
        });
    });

    // =============== EVENTO: DISCONNECT ===============
    socket.on('disconnect', () => {
        const roomId = playerRooms[socket.id];
        
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            
            // Remove player da sala
            room.players = room.players.filter(p => p.id !== socket.id);
            
            console.log(`❌ Jogador saiu: ${socket.id} da sala ${room.name}`);
            
            // Se sala ficou vazia, deleta
            if (room.players.length === 0) {
                delete rooms[roomId];
                console.log(`🗑️ Sala deletada: ${room.name}`);
                updateRoomList();
            } else {
                // Avisa outros que alguém saiu
                io.to(roomId).emit('playerDisconnected', socket.id);
            }
        }
        
        delete playerRooms[socket.id];
    });
});

// A porta que o servidor vai ouvir (Render usa a variável PORT, local usa 3000)
// O Render injeta a porta automaticamente em process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
});
