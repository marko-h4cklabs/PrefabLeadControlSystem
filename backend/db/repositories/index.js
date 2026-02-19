const companyRepository = require('./companyRepository');
const userRepository = require('./userRepository');
const leadRepository = require('./leadRepository');
const qualificationFieldRepository = require('./qualificationFieldRepository');
const conversationRepository = require('./conversationRepository');
const webhookEventsRepository = require('./webhookEventsRepository');
const analyticsSnapshotRepository = require('./analyticsSnapshotRepository');
const chatbotCompanyInfoRepository = require('./chatbotCompanyInfoRepository');
const chatbotBehaviorRepository = require('./chatbotBehaviorRepository');
const chatbotQuoteFieldsRepository = require('./chatbotQuoteFieldsRepository');
const chatbotScrapedPagesRepository = require('./chatbotScrapedPagesRepository');

module.exports = {
  companyRepository,
  userRepository,
  leadRepository,
  qualificationFieldRepository,
  conversationRepository,
  webhookEventsRepository,
  analyticsSnapshotRepository,
  chatbotCompanyInfoRepository,
  chatbotBehaviorRepository,
  chatbotQuoteFieldsRepository,
  chatbotScrapedPagesRepository,
};
