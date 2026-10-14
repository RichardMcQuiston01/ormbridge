'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    Customer: require('./customer')(sequelize, DataTypes),
    Order: require('./order')(sequelize, DataTypes),
    OrderItem: require('./orderItem')(sequelize, DataTypes),
    Product: require('./product')(sequelize, DataTypes),
    Label: require('./label')(sequelize, DataTypes),
    Comment: require('./comment')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
