import {
  DataTypes,
  Model,
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
  declare item_id: number;
  declare account_id: number;

  declare item?: NonAttribute<Item>;
  declare account?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Assignment {
    Assignment.init(
      {
        item_id: { type: DataTypes.INTEGER, primaryKey: true },
        account_id: { type: DataTypes.INTEGER, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Assignment',
        tableName: 'blog_assignment',
        timestamps: false,
      }
    );
    return Assignment;
  }
}
