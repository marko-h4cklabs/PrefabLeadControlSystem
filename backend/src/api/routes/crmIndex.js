const express = require('express');
const crmLeadRouter = require('./crm');

const crmRouter = express.Router();
crmRouter.use('/leads/:leadId', crmLeadRouter);

module.exports = crmRouter;
