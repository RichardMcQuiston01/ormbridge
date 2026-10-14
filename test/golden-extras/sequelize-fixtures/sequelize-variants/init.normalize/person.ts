import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

export class Person extends Model<
  InferAttributes<Person>,
  InferCreationAttributes<Person>
> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare born: CreationOptional<string | null>;
  declare wakeUp: CreationOptional<string | null>;
  declare photo: CreationOptional<Buffer | null>;
  declare height: CreationOptional<number | null>;
  declare rank: CreationOptional<string | null>;
  declare shelf: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;

  declare friends?: NonAttribute<Person[]>;

  static initModel(sequelize: Sequelize): typeof Person {
    Person.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        name: { type: DataTypes.STRING(255), allowNull: false },
        born: DataTypes.DATEONLY,
        wakeUp: DataTypes.TIME,
        photo: DataTypes.BLOB,
        height: DataTypes.DOUBLE,
        rank: DataTypes.BIGINT,
        shelf: DataTypes.INTEGER,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: DataTypes.DATE,
      },
      {
        sequelize,
        modelName: 'Person',
        tableName: 'person',
        timestamps: true,
        underscored: true,
      }
    );
    return Person;
  }
}
