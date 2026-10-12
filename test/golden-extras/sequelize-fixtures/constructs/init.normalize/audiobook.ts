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

export class Audiobook extends Model<
  InferAttributes<Audiobook>,
  InferCreationAttributes<Audiobook>
> {
  declare minutes: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare bookPtrId: string;

  declare book?: NonAttribute<Book>;

  static initModel(sequelize: Sequelize): typeof Audiobook {
    Audiobook.init(
      {
        minutes: { type: DataTypes.INTEGER, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        bookPtrId: { type: DataTypes.UUID, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Audiobook',
        tableName: 'audiobook',
        timestamps: true,
        underscored: true,
      }
    );
    return Audiobook;
  }
}
