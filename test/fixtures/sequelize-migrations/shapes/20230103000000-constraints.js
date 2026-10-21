'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('devices', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      serial: { type: Sequelize.STRING(32), allowNull: false },
      account_id: { type: Sequelize.BIGINT, allowNull: false },
      label: { type: Sequelize.STRING(60), allowNull: true },
      kind: { type: Sequelize.STRING(20), allowNull: false },
    });
    await queryInterface.addConstraint('devices', {
      fields: ['serial'],
      type: 'unique',
      name: 'devices_serial_unique',
    });
    await queryInterface.addConstraint('devices', {
      fields: ['account_id', 'kind'],
      type: 'unique',
      name: 'devices_account_kind_unique',
    });
    await queryInterface.addIndex('devices', ['label'], {
      name: 'devices_label',
    });
    await queryInterface.addIndex('devices', ['label', 'kind'], {
      name: 'devices_label_kind',
    });
    await queryInterface.removeIndex('devices', 'devices_label');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('devices');
  },
};
