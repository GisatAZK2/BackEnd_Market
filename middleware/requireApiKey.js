const fs = require('fs');
const path = require('path');

const keysFilePath = path.join(__dirname, '../keys.json');

module.exports = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(403).json({ message: 'Forbidden. No API key provided.' });
  }

  let apiKeys = [];
  try {
    const fileContent = fs.readFileSync(keysFilePath, 'utf-8');
    apiKeys = JSON.parse(fileContent);
  } catch (err) {
    return res.status(500).json({ message: 'Error loading API keys.' });
  }

  const validKey = apiKeys.find(k => k.key === apiKey && k.active);

  if (!validKey) {
    return res.status(403).json({ message: 'Forbidden. Invalid or inactive API key.' });
  }

  next();
};
