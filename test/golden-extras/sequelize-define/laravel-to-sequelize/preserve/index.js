'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    User: require('./user')(sequelize, DataTypes),
    Category: require('./category')(sequelize, DataTypes),
    Tag: require('./tag')(sequelize, DataTypes),
    Post: require('./post')(sequelize, DataTypes),
    Profile: require('./profile')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
