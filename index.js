const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const requireApiKey = require('./middleware/requireApiKey');
const authRoutes = require('./routes/auth');
const forumpendaftaran= require('./routes/forum-pendaftaran');
const product = require('./routes/product')
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(requireApiKey); // Protect all routes
app.use('/auth', authRoutes);
app.use('/forum-pendaftaran',forumpendaftaran);
app.use('/product',product);


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
