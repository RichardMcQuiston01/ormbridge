import {
  DataTypes,
  Model,
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
  declare book_ptr_id: string;

  declare book?: NonAttribute<Book>;

  static initModel(sequelize: Sequelize): typeof Audiobook {
    Audiobook.init(
      {
        minutes: { type: DataTypes.INTEGER, allowNull: false },
        book_ptr_id: { type: DataTypes.BIGINT, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Audiobook',
        tableName: 'audiobooks',
        timestamps: false,
      }
    );
    return Audiobook;
  }
}
