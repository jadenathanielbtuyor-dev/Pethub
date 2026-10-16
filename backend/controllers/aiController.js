const aiService = require('../services/aiService');
const { createControllerHandler } = require('../utils/controllerFactory');

const chat = createControllerHandler(aiService.chat, 'chat');

module.exports = {
  chat
};
