'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Author: require('./author')(sequelize, DataTypes),
    Book: require('./book')(sequelize, DataTypes),
    Series: require('./series')(sequelize, DataTypes),
    Audiobook: require('./audiobook')(sequelize, DataTypes),
    Index: require('./index2')(sequelize, DataTypes),
    Tagged: require('./tagged')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
