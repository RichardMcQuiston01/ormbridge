'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Author: require('./author')(sequelize, DataTypes),
    Profile: require('./profile')(sequelize, DataTypes),
    Post: require('./post')(sequelize, DataTypes),
    Category: require('./category')(sequelize, DataTypes),
    Tag: require('./tag')(sequelize, DataTypes),
    PostTag: require('./postTag')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
