import type { Sequelize } from 'sequelize';
import { Account } from './account.js';
import { Person } from './person.js';
import { AuditEntry } from './auditEntry.js';
import { Group } from './group.js';
import { Membership } from './membership.js';
import { Order } from './order.js';
import { Setting } from './setting.js';
import { Event } from './event.js';
import { Ticket } from './ticket.js';
import { Country } from './country.js';
import { City } from './city.js';

export { Account, Person, AuditEntry, Group, Membership, Order, Setting, Event, Ticket, Country, City };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Account.initModel(sequelize);
  Person.initModel(sequelize);
  AuditEntry.initModel(sequelize);
  Group.initModel(sequelize);
  Membership.initModel(sequelize);
  Order.initModel(sequelize);
  Setting.initModel(sequelize);
  Event.initModel(sequelize);
  Ticket.initModel(sequelize);
  Country.initModel(sequelize);
  City.initModel(sequelize);

  Person.belongsToMany(Person, {
    as: 'friends',
    through: 'people_friends',
    foreignKey: 'from_person_id',
    otherKey: 'to_person_id',
    timestamps: false,
  });

  Membership.belongsTo(Account, {
    as: 'account',
    foreignKey: 'AccountId',
    onDelete: 'CASCADE',
  });

  Membership.belongsTo(Group, {
    as: 'group',
    foreignKey: 'GroupId',
    onDelete: 'CASCADE',
  });

  Order.belongsTo(Account, {
    as: 'account',
    foreignKey: 'AccountId',
    onDelete: 'SET NULL',
  });
  Account.hasMany(Order, {
    as: 'orders',
    foreignKey: 'AccountId',
    onDelete: 'SET NULL',
  });

  Order.belongsTo(Account, {
    as: 'buyer',
    foreignKey: 'buyerId',
    onDelete: 'SET NULL',
  });

  Order.belongsTo(Account, {
    as: 'referrer',
    foreignKey: 'referrerEmail',
    targetKey: 'email',
    onDelete: 'RESTRICT',
  });

  Ticket.belongsTo(Event, {
    as: 'event',
    foreignKey: 'eventId',
    onDelete: 'CASCADE',
  });

  City.belongsTo(Country, {
    as: 'country',
    foreignKey: 'countryCode',
    onDelete: 'CASCADE',
  });

  return { Account, Person, AuditEntry, Group, Membership, Order, Setting, Event, Ticket, Country, City };
}

export type Models = ReturnType<typeof initModels>;
