const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const jwt = require("jsonwebtoken");
require("dotenv").config();
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors:{
        origin: "*",
    }
});

const COOLDOWN_MS = 3000;
const lastActionTime = new Map(); // socket.id -> timestamp

let waitingQueue = [];
let pairs = {};

io.on('connection', (socket) => {
    console.log("User connected: " + socket.id);
    
    socket.on("join", async ({ token }) => {

        console.log("Join request from:", socket.id);

        try {
            // 1️⃣ Validate token
            const response = await axios.post(
                `${process.env.AUTH_BASE_URL}/auth/validate-token`,
                {},
                { headers: { Authorization: token } }
            );

            if (!response.data) {
                socket.disconnect();
                return;
            }

            // 2️⃣ Decode and SET EMAIL IMMEDIATELY
            const decoded = jwt.decode(token.replace("Bearer ", ""));
            socket.userEmail = decoded.sub;

            if (!socket.userEmail) {
                console.log("No email in token, disconnecting");
                socket.disconnect();
                return;
            }

            // 3️⃣ Matching
            while (waitingQueue.length > 0) {

                const partnerId = waitingQueue.shift();
                const partnerSocket = io.sockets.sockets.get(partnerId);

                // 🔴 CRITICAL SAFETY CHECK
                if (!partnerSocket || !partnerSocket.userEmail) {
                    continue;
                }

                const canChatResp = await axios.post(
                    `${process.env.AUTH_BASE_URL}/block/can-chat`,
                    {
                        userA: socket.userEmail,
                        userB: partnerSocket.userEmail
                    }
                );

                if (!canChatResp.data) {
                    continue;
                }

                pairs[socket.id] = partnerId;
                pairs[partnerId] = socket.id;

                socket.emit("matched", { initiator: true });
                io.to(partnerId).emit("matched", { initiator: false });
                return;
            }

            // 4️⃣ Add to queue ONLY AFTER identity is known
            waitingQueue.push(socket.id);
            console.log("User added to queue:", socket.id);

        } catch (err) {
            console.log("Error during join:", err.message);
            socket.disconnect();
        }
    });


    socket.on("offer", (data) => {
        const partner = pairs[socket.id];
        if(partner){
            io.to(partner).emit("offer", data);
        }
    });

    socket.on("answer", (data) =>{
        const partner = pairs[socket.id];
        if(partner){
            io.to(partner).emit("answer", data);
        }
    });

    socket.on("ice", (data) => {
        const partner = pairs[socket.id];
        if(partner){
            io.to(partner).emit("ice", data);
        }
    });

    socket.on('disconnect', () => {
        console.log("User disconnected: " + socket.id);
        waitingQueue = waitingQueue.filter(id => id !== socket.id);

        const partner = pairs[socket.id];
        if(partner){
            io.to(partner).emit("leave");
            delete pairs[partner];
        }
        lastActionTime.delete(socket.id);
        delete pairs[socket.id];
    });

    socket.on("leave-manual", () => {

        if (isOnCooldown(socket)) {
            return;
        }

        const partner = pairs[socket.id];

        if (partner) {
            io.to(partner).emit("leave");
            delete pairs[partner];
        }

        delete pairs[socket.id];
    });

});


function isOnCooldown(socket) {

    const now = Date.now();
    const last = lastActionTime.get(socket.id) || 0;

    if (now - last < COOLDOWN_MS) {
        return true;
    }

    lastActionTime.set(socket.id, now);
    return false;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log("Signaling running on", PORT);
});
