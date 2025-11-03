import http from "http";

const PORT = process.env.PORT || 10000;

export function startHealthCheckServer() {
    const server = http.createServer((req, res) => {
        if (req.url === "/health" || req.url === "/") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    status: "ok",
                    timestamp: new Date().toISOString(),
                    uptime: process.uptime(),
                    service: "desco-balance-check-bot",
                })
            );
        } else {
            res.writeHead(404);
            res.end("Not found");
        }
    });

    server.listen(PORT, () => {
        console.log(`✅ Health check server running on port ${PORT}`);
    });

    return server;
}
