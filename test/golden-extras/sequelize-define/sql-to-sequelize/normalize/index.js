'use strict';

const { DataTypes } = require('sequelize');

// Defines every model on a Sequelize instance, then runs the associate functions:
//   const { initModels } = require('./models');
//   const models = initModels(sequelize);
function initModels(sequelize) {
  const models = {
    BlogUser: require('./blogUser')(sequelize, DataTypes),
    BlogCategory: require('./blogCategory')(sequelize, DataTypes),
    BlogTag: require('./blogTag')(sequelize, DataTypes),
    BlogPost: require('./blogPost')(sequelize, DataTypes),
    BlogProfile: require('./blogProfile')(sequelize, DataTypes),
  };
  Object.values(models).forEach((model) => {
    if (model.associate) {
      model.associate(models);
    }
  });
  return models;
}

module.exports = { initModels };
