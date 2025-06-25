const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const requireApiKey = require('./middleware/requireApiKey');
const authRoutes = require('./routes/auth');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(requireApiKey); // Protect all routes
app.use('/auth', authRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
