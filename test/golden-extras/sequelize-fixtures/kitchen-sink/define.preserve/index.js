'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Account: require('./account')(sequelize, DataTypes),
    Session: require('./session')(sequelize, DataTypes),
    Group: require('./group')(sequelize, DataTypes),
    Membership: require('./membership')(sequelize, DataTypes),
    Profile: require('./profile')(sequelize, DataTypes),
    LegacyOrder: require('./legacyOrder')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
