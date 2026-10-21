import { DataTypes, QueryInterface } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('articles', {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    headline: { type: DataTypes.STRING(160), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    status: {
      type: DataTypes.ENUM('draft', 'published'),
      allowNull: false,
      defaultValue: 'draft',
    },
    views: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    published_on: DataTypes.DATEONLY,
  });
  await queryInterface.addIndex('articles', ['status', 'published_on'], {
    name: 'articles_status_day',
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('articles');
}
