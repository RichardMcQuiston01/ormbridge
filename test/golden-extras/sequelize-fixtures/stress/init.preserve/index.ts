import type { Sequelize } from 'sequelize';
import { Weird } from './weird.js';
import { Other } from './other.js';

export { Weird, Other };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Weird.initModel(sequelize);
  Other.initModel(sequelize);

  Weird.belongsTo(Weird, {
    as: 'self',
    foreignKey: 'self_id',
    onDelete: 'SET NULL',
  });

  Weird.belongsTo(Other, {
    as: 'other',
    foreignKey: 'other_id',
    onDelete: 'CASCADE',
  });
  Other.hasMany(Weird, {
    as: 'weirds',
    foreignKey: 'other_id',
    onDelete: 'CASCADE',
  });

  return { Weird, Other };
}

export type Models = ReturnType<typeof initModels>;
