// --- Tempo de jogo em segundos (6 minutos)
const GAME_DURATION = 360; // 60 * 6 = 360 segundos
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
        .filter(room => {
            // ✅ Validar que a sala tem players E que não é uma sala órfã
            if (!room.players || room.players.length === 0) {
                return false;
            }
            
            // ✅ DUPLA VERIFICAÇÃO: Garantir que pelo menos 1 player na lista está realmente conectado
            const hasConnectedPlayer = room.players.some(p => io.sockets.sockets.has(p.id));
            if (!hasConnectedPlayer) {
                console.warn(`⚠️ Sala órfã detectada (sem players conectados): ${room.name}`);
                return false;
            }
            
            return true;
        })
        .map(room => ({
            roomId: room.id,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: 10,
            hasPassword: !!room.password,
            createdAt: room.createdAt
        }));
    
    console.log('📢 updateRoomList enviando:', roomList);
    console.log('📊 Salas no servidor:', Object.keys(rooms));
    
    io.emit('roomList', roomList);
}

// ✅ LIMPADOR PERIÓDICO DE SALAS VAZIAS (a cada 30 segundos)
// Garante que salas órfãs sejam removidas mesmo se houver falha na desconexão
setInterval(() => {
    let cleaned = false;
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (!room.players || room.players.length === 0) {
            console.log(`🧹 Limpando sala vazia: ${room.name}`);
            delete rooms[roomId];
            cleaned = true;
        }
    }
    if (cleaned) {
        console.log('✅ Salas vazias limpas pelo scheduler');
        updateRoomList();
    }
}, 30000); // A cada 30 segundos

// =============== EVENTO: CREATE ROOM ===============
io.on('connection', (socket) => {

        // --- INICIAR JOGO (com segurança) ---
        socket.on('startGame', (roomId) => {
            const room = rooms[roomId];
            // SEGURANÇA NO SERVIDOR:
            // Verifica se a sala existe E se quem pediu é o dono (host) E se o jogo já não começou
            if (room && room.players[0] && room.players[0].id === socket.id && !room.gameStarted) {
                console.log(`Iniciando jogo na sala ${roomId}...`);
                room.gameStarted = true; // Trava a sala para não iniciar 2 vezes
                room.timeLeft = GAME_DURATION;
                io.to(roomId).emit('gameStart', {
                    timeLeft: room.timeLeft,
                    // ... outros dados ...
                });
                // Aqui você pode iniciar o loop do timer, se desejar
            }
        });
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
            players: room.players,
            isHost: true  // 🔥 Quem criou é o Host
        });
        
        // ⏰ DELAY: Aguarda 100ms para garantir que a sala está estável antes de broadcast
        // Isso evita race conditions onde outros clientes pedem a lista antes da sala estar pronta
        setTimeout(() => {
            console.log('📢 (após delay) Chamando updateRoomList()');
            updateRoomList();
        }, 100);
    });

    // =============== EVENTO: JOIN ROOM ===============
    socket.on('joinRoom', (data) => {
        const { roomId, password, nickname } = data;
        
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Sala não encontrada');
            return;
        }
        
        // 🚫 NOVO BLOQUEIO: PARTIDA EM ANDAMENTO
        if (room.inProgress) {
            socket.emit('error', '🚫 Partida já iniciada! Espere acabar.');
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
        
        // ✅ LIMPEZA RÁPIDA: Remover salas vazias antes de enviar
        for (const roomId in rooms) {
            const room = rooms[roomId];
            // ✅ DUPLA VERIFICAÇÃO: Remover se vazia OU se nenhum player está conectado
            if (!room.players || room.players.length === 0) {
                console.log(`🧹 Removendo sala vazia ao enviar lista: ${room.name}`);
                delete rooms[roomId];
            } else {
                const hasConnectedPlayer = room.players.some(p => io.sockets.sockets.has(p.id));
                if (!hasConnectedPlayer) {
                    console.warn(`🧹 Removendo sala órfã ao enviar lista (sem players conectados): ${room.name}`);
                    delete rooms[roomId];
                }
            }
        }
        
        const roomList = Object.values(rooms)
            .filter(room => room.players && room.players.length > 0)
            .map(room => ({
                roomId: room.id,
                name: room.name,
                playerCount: room.players.length,
                maxPlayers: 10,
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
        
        // 🔒 TRAVA A SALA SE O JOGO COMEÇAR
        if (payload.action === 'START_MATCH') {
            if (rooms[roomId]) {
                rooms[roomId].inProgress = true;
                console.log(`🔒 Sala ${roomId} TRANCADA (Jogo Iniciou)`);
                updateRoomList();
            }
        }
        
        // 🔓 DESTRAVA A SALA SE O JOGO ACABAR
        if (payload.action === 'GAME_OVER' || payload.action === 'RETURNING_TO_LOBBY') {
            if (rooms[roomId]) {
                rooms[roomId].inProgress = false;
                console.log(`🔓 Sala ${roomId} DESTRANCADA (Fim de Jogo)`);
                updateRoomList();
            }
        }
        
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
        console.log(`❌ DISCONNECT: ${socket.id.substring(0,4)} saiu`);
        const roomId = playerRooms[socket.id];
        
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            console.log(`📋 Sala antes de remover: ${room.players.length} players`);
            console.log(`   Players: ${room.players.map(p => `${p.id.substring(0,4)} - ${p.name}`).join(', ')}`);
            
            // Remove player da sala
            const beforeCount = room.players.length;
            room.players = room.players.filter(p => p.id !== socket.id);
            const afterCount = room.players.length;
            
            if (beforeCount === afterCount) {
                console.warn(`⚠️ Player ${socket.id.substring(0,4)} NÃO encontrado na sala (já removido?)`);
            } else {
                console.log(`✅ Player removido. Sala: ${beforeCount} → ${afterCount} players`);
            }
            
            // Se sala ficou vazia, deleta
            if (room.players.length === 0) {
                delete rooms[roomId];
                console.log(`🗑️ Sala deletada (vazia): ${room.name}`);
                updateRoomList();
            } else {
                // Avisa outros que alguém saiu
                io.to(roomId).emit('playerDisconnected', socket.id);
                console.log(`📢 Broadcast playerDisconnected para sala ${room.name}`);
                // ✅ Atualizar lista mesmo quando alguém sai (não apenas quando vazia)
                updateRoomList();
            }
        } else {
            console.warn(`⚠️ Disconnect: roomId não encontrado para ${socket.id.substring(0,4)}`);
        }
        
        delete playerRooms[socket.id];
        console.log(`✅ playerRooms[${socket.id.substring(0,4)}] deletado`);
    });
});

// A porta que o servidor vai ouvir (Render usa a variável PORT, local usa 3000)
// O Render injeta a porta automaticamente em process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
});
