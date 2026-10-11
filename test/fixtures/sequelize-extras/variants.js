'use strict';

// Everything the canonical blog schema does not cover, written as top-level CommonJS code: Sequelize's
// default names (plural tables, `AccountId` keys), underscored and paranoid models, custom timestamp
// columns, a join model, a self-referencing many-to-many, composite unique keys, key options and
// custom indexes. Only types that SQLite can create are used, so the real-tool test can run it.
const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: ':memory:',
  logging: false,
});

// Default table name "Accounts"; createdAt and updatedAt are added.
const Account = sequelize.define('Account', {
  email: {
    type: DataTypes.STRING(120),
    allowNull: false,
    unique: 'account_email_unique',
  },
  balance: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  settings: { type: DataTypes.JSON, defaultValue: {} },
  nickname: DataTypes.STRING,
  legacyCode: { type: DataTypes.CHAR(8), field: 'legacy_code' },
  lastSeen: {
    type: DataTypes.DATE,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  fullName: {
    type: DataTypes.VIRTUAL,
    get() {
      return this.nickname;
    },
  },
});

// "People" in snake_case: underscored table, columns and timestamps, plus a soft-delete column.
const Person = sequelize.define(
  'Person',
  {
    name: { type: DataTypes.STRING, allowNull: false },
    born: DataTypes.DATEONLY,
    wakeUp: DataTypes.TIME,
    photo: DataTypes.BLOB,
    height: DataTypes.FLOAT,
    rank: DataTypes.BIGINT,
    shelf: DataTypes.SMALLINT,
  },
  { underscored: true, paranoid: true }
);

// freezeTableName keeps "AuditEntry"; one custom timestamp column and no updatedAt.
const AuditEntry = sequelize.define(
  'AuditEntry',
  {
    action: { type: DataTypes.STRING, allowNull: false },
    level: { type: DataTypes.ENUM('info', 'warn'), defaultValue: 'info' },
  },
  { freezeTableName: true, createdAt: 'logged_at', updatedAt: false }
);

// A join model of its own: the two keys become its composite primary key.
const Group = sequelize.define('Group', { title: DataTypes.STRING });
const Membership = sequelize.define(
  'Membership',
  { role: { type: DataTypes.STRING(20), defaultValue: 'member' } },
  { timestamps: false }
);
Account.belongsToMany(Group, { through: Membership });
Group.belongsToMany(Account, { through: Membership });

// Default keys and aliases, a target key other than the primary key, and constraints: false.
const Order = sequelize.define(
  'Order',
  { total: { type: DataTypes.DECIMAL(10, 2), allowNull: false } },
  { timestamps: false }
);
Account.hasMany(Order);
Order.belongsTo(Account, { as: 'buyer' });
Order.belongsTo(Account, {
  as: 'referrer',
  foreignKey: 'referrerEmail',
  targetKey: 'email',
  onDelete: 'RESTRICT',
});
Order.belongsTo(Account, {
  as: 'auditor',
  foreignKey: 'auditorId',
  constraints: false,
});

// Composite unique keys, from a shared unique name and from the uniqueKeys option.
const Setting = sequelize.define(
  'Setting',
  {
    scope: { type: DataTypes.STRING(30), unique: 'setting_scope_key' },
    key: { type: DataTypes.STRING(30), unique: 'setting_scope_key' },
    value: DataTypes.TEXT,
  },
  {
    tableName: 'settings',
    timestamps: false,
    uniqueKeys: { setting_key_value: { fields: ['key', 'value'] } },
  }
);

// Custom indexes, and a foreign key written as `references` on the column.
const Event = sequelize.define(
  'Event',
  {
    title: DataTypes.STRING(80),
    startsAt: { type: DataTypes.DATE, allowNull: false },
    capacity: DataTypes.INTEGER,
  },
  {
    tableName: 'events',
    timestamps: false,
    indexes: [
      { name: 'events_title', fields: ['title'] },
      { fields: [{ name: 'startsAt', order: 'DESC' }, 'capacity'] },
      { unique: true, fields: ['title', 'startsAt'] },
    ],
  }
);
const Ticket = sequelize.define(
  'Ticket',
  {
    eventId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'events', key: 'id' },
      onDelete: 'CASCADE',
    },
    seat: DataTypes.STRING(10),
  },
  { tableName: 'tickets', timestamps: false }
);

// A string primary key, referenced by a foreign key with a custom name.
const Country = sequelize.define(
  'Country',
  {
    code: { type: DataTypes.CHAR(2), primaryKey: true },
    name: DataTypes.STRING,
  },
  { tableName: 'countries', timestamps: false }
);
const City = sequelize.define(
  'City',
  { name: DataTypes.STRING },
  { tableName: 'cities', timestamps: false }
);
City.belongsTo(Country, { foreignKey: 'countryCode', onDelete: 'CASCADE' });

// A many-to-many to the same model needs an alias.
Person.belongsToMany(Person, {
  as: 'friends',
  through: 'friendships',
  foreignKey: 'person_id',
  otherKey: 'friend_id',
});

module.exports = sequelize;
