'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Item: require('./item')(sequelize, DataTypes),
    Counter: require('./counter')(sequelize, DataTypes),
    Shipment: require('./shipment')(sequelize, DataTypes),
    Account: require('./account')(sequelize, DataTypes),
    Assignment: require('./assignment')(sequelize, DataTypes),
    ContentType: require('./contentType')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
