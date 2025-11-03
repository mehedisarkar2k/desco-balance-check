import https from 'https';

const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutes in milliseconds

export function startKeepAlive() {
    // Only run in production (on Render)
    if (process.env.NODE_ENV !== 'production') {
        console.log('Keep-alive disabled in development mode');
        return;
    }

    const url = process.env.RENDER_EXTERNAL_URL;

    if (!url) {
        console.warn('RENDER_EXTERNAL_URL not set, keep-alive disabled');
        return;
    }

    console.log(`Starting keep-alive ping to ${url} every 14 minutes`);

    setInterval(() => {
        const pingUrl = `${url}/health`;

        https.get(pingUrl, (res) => {
            console.log(`Keep-alive ping: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`Keep-alive ping failed: ${err.message}`);
        });
    }, KEEP_ALIVE_INTERVAL);
}
