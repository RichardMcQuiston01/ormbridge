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

export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  declare id: CreationOptional<string>;
  declare handle: string;
  declare favourite_book_id: CreationOptional<number | null>;
  declare latest_book_id: CreationOptional<string | null>;

  declare latest_book?: NonAttribute<Book>;
  declare books?: NonAttribute<Book[]>;
  declare edited_books?: NonAttribute<Book[]>;

  static initModel(sequelize: Sequelize): typeof Author {
    Author.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        handle: { type: DataTypes.STRING(30), allowNull: false, unique: true },
        favourite_book_id: DataTypes.INTEGER,
        latest_book_id: DataTypes.BIGINT,
      },
      {
        sequelize,
        modelName: 'Author',
        tableName: 'authors',
        timestamps: false,
      }
    );
    return Author;
  }
}
