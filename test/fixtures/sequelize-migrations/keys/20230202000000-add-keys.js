'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addConstraint('people', {
      fields: ['email'],
      type: 'unique',
      name: 'people_email_unique',
    });
    await queryInterface.addConstraint('people', {
      fields: ['nickname'],
      type: 'unique',
      name: 'people_nickname_unique',
    });
    await queryInterface.addConstraint('projects', {
      fields: ['code'],
      type: 'primary key',
      name: 'projects_pkey',
    });
    await queryInterface.addConstraint('projects', {
      fields: ['owner_id'],
      type: 'foreign key',
      name: 'projects_owner_fk',
      references: { table: 'people', field: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addConstraint('memberships', {
      fields: ['person_id', 'project_code'],
      type: 'primary key',
      name: 'memberships_pkey',
    });
    await queryInterface.addConstraint('memberships', {
      fields: ['person_id'],
      type: 'foreign key',
      name: 'memberships_person_fk',
      references: { table: 'people', field: 'id' },
      onDelete: 'CASCADE',
    });
    await queryInterface.addConstraint('memberships', {
      fields: ['project_code'],
      type: 'foreign key',
      name: 'memberships_project_fk',
      references: { table: 'projects', field: 'code' },
      onDelete: 'CASCADE',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint(
      'memberships',
      'memberships_project_fk'
    );
  },
};
