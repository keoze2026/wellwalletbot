// pm2 process definition for the WellWallet bot.
// Note: .cjs (not .js) because package.json sets "type": "module", and pm2
// config files must be CommonJS.
//
//   pm2 start ecosystem.config.cjs
//
module.exports = {
  apps: [
    {
      name: "wellwalletbot",
      script: "dist/index.js",
      cwd: "/root/wellwalletbot", // so dotenv finds /root/wellwalletbot/.env
      // Long polling: ONLY ONE instance may poll the bot token at a time.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
