import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Account } from './account.js';
import type { Item } from './item.js';

export class Assignment extends Model<
  InferAttributes<Assignment>,
  InferCreationAttributes<Assignment>
> {
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare itemId: string;
  declare accountId: string;

  declare item?: NonAttribute<Item>;
  declare account?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Assignment {
    Assignment.init(
      {
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        itemId: { type: DataTypes.UUID, primaryKey: true },
        accountId: { type: DataTypes.UUID, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Assignment',
        tableName: 'assignment',
        timestamps: true,
        underscored: true,
      }
    );
    return Assignment;
  }
}
