import type { Sequelize } from 'sequelize';
import { Account } from './account.js';
import { Session } from './session.js';
import { Group } from './group.js';
import { Membership } from './membership.js';
import { Profile } from './profile.js';
import { LegacyOrder } from './legacyOrder.js';

export { Account, Session, Group, Membership, Profile, LegacyOrder };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Account.initModel(sequelize);
  Session.initModel(sequelize);
  Group.initModel(sequelize);
  Membership.initModel(sequelize);
  Profile.initModel(sequelize);
  LegacyOrder.initModel(sequelize);

  Session.belongsTo(Account, {
    as: 'account',
    foreignKey: 'accountId',
    onDelete: 'SET NULL',
  });
  Account.hasMany(Session, {
    as: 'sessions',
    foreignKey: 'accountId',
    onDelete: 'SET NULL',
  });

  Group.belongsToMany(Group, {
    as: 'friends',
    through: 'group_friends',
    foreignKey: 'from_group_id',
    otherKey: 'to_group_id',
    timestamps: false,
  });
  Group.belongsToMany(Group, {
    as: 'friendOf',
    through: 'group_friends',
    foreignKey: 'to_group_id',
    otherKey: 'from_group_id',
    timestamps: false,
  });

  Membership.belongsTo(Account, {
    as: 'account',
    foreignKey: 'accountId',
    onDelete: 'CASCADE',
  });

  Membership.belongsTo(Group, {
    as: 'group',
    foreignKey: 'groupId',
    onDelete: 'RESTRICT',
  });

  Profile.belongsTo(Account, {
    as: 'owner',
    foreignKey: 'ownerAccountId',
    onDelete: 'CASCADE',
  });
  Account.hasOne(Profile, {
    as: 'profile',
    foreignKey: 'ownerAccountId',
    onDelete: 'CASCADE',
  });

  LegacyOrder.belongsTo(Account, {
    as: 'owner',
    foreignKey: 'acct',
    onDelete: 'NO ACTION',
  });

  return { Account, Session, Group, Membership, Profile, LegacyOrder };
}

export type Models = ReturnType<typeof initModels>;
