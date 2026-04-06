const { join } = require('path');

/**
 * Puppeteer configuration for Render deployment.
 * Ensures Chrome is cached within the project directory
 * so it persists across deploys on Render.
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
