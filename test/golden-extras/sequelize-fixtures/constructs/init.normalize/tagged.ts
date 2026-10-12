import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Book } from './book.js';

export class Tagged extends Model<
  InferAttributes<Tagged>,
  InferCreationAttributes<Tagged>
> {
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare books?: NonAttribute<Book[]>;

  static initModel(sequelize: Sequelize): typeof Tagged {
    Tagged.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Tagged',
        tableName: 'tagged',
        timestamps: true,
        underscored: true,
      }
    );
    return Tagged;
  }
}
