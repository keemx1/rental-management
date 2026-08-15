module.exports = {
  apps: [
    {
      name: 'rental-sys',
      script: 'backend/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: { NODE_ENV: 'production', PORT: 3001 },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
    },
  ],
};
