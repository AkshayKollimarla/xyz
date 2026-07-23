module.exports = {
  apps: [
    {
      name: 'arbitrum-usdc-forwarder',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      // Never run more than one instance: with more than one process
      // polling the same wallet, you risk duplicate/overlapping forwards.
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '30s',
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
