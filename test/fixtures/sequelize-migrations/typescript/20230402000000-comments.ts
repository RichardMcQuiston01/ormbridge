import { DataTypes, QueryInterface } from 'sequelize';

const TABLE: string = 'comments';

module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.createTable(TABLE, {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      article_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'articles', key: 'id' },
        onDelete: 'CASCADE',
      },
      author: { type: DataTypes.STRING(60), allowNull: true },
      text: { type: DataTypes.TEXT, allowNull: false },
    });
    await queryInterface.addIndex(TABLE, ['article_id']);
  },
  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.dropTable(TABLE);
  },
};
