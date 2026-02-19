const companyRepository = require('./companyRepository');
const userRepository = require('./userRepository');
const leadRepository = require('./leadRepository');
const qualificationFieldRepository = require('./qualificationFieldRepository');
const conversationRepository = require('./conversationRepository');
const webhookEventsRepository = require('./webhookEventsRepository');
const analyticsSnapshotRepository = require('./analyticsSnapshotRepository');

module.exports = {
  companyRepository,
  userRepository,
  leadRepository,
  qualificationFieldRepository,
  conversationRepository,
  webhookEventsRepository,
  analyticsSnapshotRepository,
};
