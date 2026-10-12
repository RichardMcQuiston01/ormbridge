'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Account: require('./account')(sequelize, DataTypes),
    Person: require('./person')(sequelize, DataTypes),
    AuditEntry: require('./auditEntry')(sequelize, DataTypes),
    Group: require('./group')(sequelize, DataTypes),
    Membership: require('./membership')(sequelize, DataTypes),
    Order: require('./order')(sequelize, DataTypes),
    Setting: require('./setting')(sequelize, DataTypes),
    Event: require('./event')(sequelize, DataTypes),
    Ticket: require('./ticket')(sequelize, DataTypes),
    Country: require('./country')(sequelize, DataTypes),
    City: require('./city')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
