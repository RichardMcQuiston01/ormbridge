'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Order: require('./order')(sequelize, DataTypes),
    OrderLine: require('./orderLine')(sequelize, DataTypes),
    Account: require('./account')(sequelize, DataTypes),
    Tenant: require('./tenant')(sequelize, DataTypes),
    Profile: require('./profile')(sequelize, DataTypes),
    Document: require('./document')(sequelize, DataTypes),
    Scratch: require('./scratch')(sequelize, DataTypes),
    DocumentSummary: require('./documentSummary')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
