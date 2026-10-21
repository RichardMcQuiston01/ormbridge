'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.removeConstraint('people', 'people_nickname_unique');
    await queryInterface.addIndex('people', ['nickname'], {
      name: 'people_nickname',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('people', 'people_nickname');
  },
};
