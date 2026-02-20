const net = require('net');

function checkPort(port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { resolve(false); });
    socket.connect(port, 'localhost');
  });
}

function guessFramework(port) {
  const portMap = {
    3000: 'React/Next.js',
    3001: 'Unknown',
    5000: 'Flask/Express',
    5173: 'Vite',
    8000: 'Python/Django',
    8080: 'Vue CLI/HTTP Server',
    8888: 'Jupyter',
    9000: 'Angular'
  };
  return portMap[port] || 'Unknown';
}

async function detectOpenPorts() {
  const commonPorts = [3000, 3001, 5000, 5173, 8000, 8080, 8888, 9000];

  const checks = commonPorts.map(async (port) => {
    const isOpen = await checkPort(port);
    if (isOpen) {
      return { port, url: `/preview/${port}`, type: guessFramework(port), status: 'running' };
    }
    return null;
  });

  const results = await Promise.all(checks);
  return results.filter(result => result !== null);
}

function isValidPort(port) {
  return port >= 3000 && port <= 9999;
}

function isBlockedPort(port) {
  const SERVER_PORT = parseInt(process.env.PORT) || 3001;
  const BLOCKED_PORTS = [22, 80, 443, SERVER_PORT, 3306, 5432, 6379, 27017, 9200];
  return BLOCKED_PORTS.includes(port);
}

module.exports = { checkPort, guessFramework, detectOpenPorts, isValidPort, isBlockedPort };
