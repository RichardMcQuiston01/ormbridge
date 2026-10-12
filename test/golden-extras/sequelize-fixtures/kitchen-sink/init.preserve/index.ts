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
    foreignKey: 'account_id',
    onDelete: 'SET NULL',
  });
  Account.hasMany(Session, {
    as: 'sessions',
    foreignKey: 'account_id',
    onDelete: 'SET NULL',
  });

  Group.belongsToMany(Group, {
    as: 'friends',
    through: 'groups_friends',
    foreignKey: 'from_group_id',
    otherKey: 'to_group_id',
    timestamps: false,
  });
  Group.belongsToMany(Group, {
    as: 'friend_of',
    through: 'groups_friends',
    foreignKey: 'to_group_id',
    otherKey: 'from_group_id',
    timestamps: false,
  });

  Membership.belongsTo(Account, {
    as: 'account',
    foreignKey: 'account_id',
    onDelete: 'CASCADE',
  });

  Membership.belongsTo(Group, {
    as: 'group',
    foreignKey: 'group_id',
    onDelete: 'RESTRICT',
  });

  Profile.belongsTo(Account, {
    as: 'owner',
    foreignKey: 'owner_account_id',
    onDelete: 'CASCADE',
  });
  Account.hasOne(Profile, {
    as: 'profile',
    foreignKey: 'owner_account_id',
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
